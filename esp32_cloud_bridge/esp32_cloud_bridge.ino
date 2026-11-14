/*
 ==============================================================================
  AquaNav Cloud Bridge - Domain-Agnostic ESP32-S3-CAM Firmware
  Board    : GOOUUU ESP32-S3-CAM (N16R8: 16MB Flash, 8MB Octal PSRAM)
  Framework: Arduino / ESP32-S3
 ==============================================================================
  Features:
    - Connects over Wi-Fi (STA) to ANY configurable cloud domain (.onrender.com,
      .in, .com, .tech, .me, or local http://IP:5000).
    - Persists SERVER_BASE_URL & Wi-Fi credentials in NVS Flash (Preferences).
    - Dynamic runtime reconfiguration over USB Serial (115200 baud) WITHOUT
      recompiling:
        * SET_URL:https://your-domain.in
        * SET_WIFI:YourSSID,YourPassword
        * GET_CONFIG
    - Uses WiFiClientSecure (setInsecure) + HTTPC_STRICT_FOLLOW_REDIRECTS.
    - POSTs Uno UART telemetry JSON to /api/telemetry and forwards the returned
      motor command ('F','B','L','R','S') & siren state to Arduino Uno in 1 RTT.
    - Captures QVGA (320x240) JPEG frames and POSTs them to /api/esp32/frame.
 ==============================================================================
*/

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include "esp_camera.h"
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"

// Override ESP-IDF brownout initialization to prevent spurious brownout resets on USB power
extern "C" void esp_brownout_init(void) {
    // Intentionally empty: completely disables ESP-IDF BOD interrupt and handler
}

extern "C" void esp_brownout_disable(void) {
    // Intentionally empty
}

// Run before setup() to eliminate USB brownout reset during Octal PSRAM & Wi-Fi calibration
__attribute__((constructor)) void preInitBodDisable() {
    WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);
}

// ----------------------------------------------------------------------------
// 1. HARDWARE PIN DEFINITIONS (GOOUUU ESP32-S3-CAM OV2640)
// ----------------------------------------------------------------------------
#define PWDN_GPIO_NUM     -1
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM     15
#define SIOD_GPIO_NUM      4
#define SIOC_GPIO_NUM      5

#define Y9_GPIO_NUM       16
#define Y8_GPIO_NUM       17
#define Y7_GPIO_NUM       18
#define Y6_GPIO_NUM       12
#define Y5_GPIO_NUM       10
#define Y4_GPIO_NUM        8
#define Y3_GPIO_NUM        9
#define Y2_GPIO_NUM       11
#define VSYNC_GPIO_NUM     6
#define HREF_GPIO_NUM      7
#define PCLK_GPIO_NUM     13

// Hardware Serial Pins for Arduino Uno UART Bridge (115200 Baud matching Arduino Uno)
// Connect ESP32 GPIO 44 (RX) -> Arduino Uno TX (Pin 1)
// Connect ESP32 GPIO 43 (TX) -> Arduino Uno RX (Pin 0)
#define UART_UNO_RX_PIN   44
#define UART_UNO_TX_PIN   43
#define UART_BAUD_RATE    115200

// On GOOUUU ESP32-S3-CAM, GPIO 44 (RX) and GPIO 43 (TX) are the primary hardware UART (UART0)
// Map Serial1 to Serial to ensure seamless unified operation with both PC Serial Monitor and Arduino Uno
#define Serial1 Serial

// ----------------------------------------------------------------------------
// 2. CLOUD SERVER & WI-FI CONFIGURATION (PERSISTED IN NVS FLASH)
// ----------------------------------------------------------------------------
Preferences preferences;

const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";
String SERVER_BASE_URL = "https://aquanav.onrender.com";

// Active runtime Wi-Fi credentials (initialized from constants, auto-fallback to hotspot or NVS)
String activeSsid = (strcmp(WIFI_SSID, "YOUR_WIFI_NAME") == 0) ? "vivo T2x 5G" : String(WIFI_SSID);
String activePass = (strcmp(WIFI_PASS, "YOUR_WIFI_PASSWORD") == 0) ? "1234567890" : String(WIFI_PASS);

const unsigned long TELEMETRY_INTERVAL_MS = 500; // 500ms telemetry POST
const unsigned long FRAME_INTERVAL_MS     = 350; // 350ms QVGA frame uplink

unsigned long lastTelemetryPostMs = 0;
unsigned long lastFramePostMs     = 0;

// Cached Uno Telemetry Values
float cachedDistanceCm = 120.0;
bool  cachedWaterLeak  = false;
float cachedLat        = 12.971600;
float cachedLon        = 77.594600;
float cachedBatteryV   = 12.20;

char  lastForwardedCmd = 'S';
bool  lastSirenState   = false;

String uartLineBuffer  = "";
String usbLineBuffer   = "";

// ----------------------------------------------------------------------------
// 3. CAMERA INITIALIZATION (QVGA 320x240 FOR FAST CLOUD UPLINK)
// ----------------------------------------------------------------------------
esp_err_t initCamera() {
    camera_config_t config;
    config.ledc_channel = LEDC_CHANNEL_0;
    config.ledc_timer   = LEDC_TIMER_0;
    config.pin_d0       = Y2_GPIO_NUM;
    config.pin_d1       = Y3_GPIO_NUM;
    config.pin_d2       = Y4_GPIO_NUM;
    config.pin_d3       = Y5_GPIO_NUM;
    config.pin_d4       = Y6_GPIO_NUM;
    config.pin_d5       = Y7_GPIO_NUM;
    config.pin_d6       = Y8_GPIO_NUM;
    config.pin_d7       = Y9_GPIO_NUM;
    config.pin_xclk     = XCLK_GPIO_NUM;
    config.pin_pclk     = PCLK_GPIO_NUM;
    config.pin_vsync    = VSYNC_GPIO_NUM;
    config.pin_href     = HREF_GPIO_NUM;
    config.pin_sccb_sda = SIOD_GPIO_NUM;
    config.pin_sccb_scl = SIOC_GPIO_NUM;
    config.pin_pwdn     = PWDN_GPIO_NUM;
    config.pin_reset    = RESET_GPIO_NUM;
    config.xclk_freq_hz = 20000000;
    config.pixel_format = PIXFORMAT_JPEG;

    // QVGA (320x240) keeps frame size ~8-15KB for smooth Wi-Fi -> Cloud relay
    config.frame_size   = FRAMESIZE_QVGA;
    config.jpeg_quality = 14;
    if (psramFound()) {
        config.fb_location = CAMERA_FB_IN_PSRAM;
        config.fb_count  = 2;
        config.grab_mode = CAMERA_GRAB_LATEST;
    } else {
        config.fb_location = CAMERA_FB_IN_DRAM;
        config.fb_count  = 1;
        config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
    }

    esp_err_t err = esp_camera_init(&config);
    if (err != ESP_OK && psramFound()) {
        Serial.println("[CAMERA] Retrying camera init with internal DRAM buffer...");
        config.fb_location = CAMERA_FB_IN_DRAM;
        config.fb_count    = 1;
        config.grab_mode   = CAMERA_GRAB_WHEN_EMPTY;
        err = esp_camera_init(&config);
    }

    if (err != ESP_OK) {
        Serial.printf("[CAMERA WARNING] Camera init error: 0x%x (camera optional, telemetry & UART active)\n", err);
        return err;
    }

    sensor_t* s = esp_camera_sensor_get();
    if (s != NULL) {
        s->set_aec2(s, 1);
        s->set_ae_level(s, -1);
        s->set_gainceiling(s, GAINCEILING_2X);
        s->set_whitebal(s, 1);
        s->set_bpc(s, 1);
        s->set_wpc(s, 1);
        s->set_lenc(s, 1);
        Serial.println("[CAMERA] OV2640 QVGA (320x240) calibrated for cloud streaming.");
    }
    return ESP_OK;
}

// ----------------------------------------------------------------------------
// 4. NVS PREFERENCES & SERIAL RUNTIME CONFIGURATION
// ----------------------------------------------------------------------------
String normalizeBaseUrl(String url) {
    url.trim();
    while (url.endsWith("/")) {
        url.remove(url.length() - 1);
    }
    return url;
}

void loadPreferences() {
    preferences.begin("aquanav", false);
    String savedUrl  = preferences.getString("server_url", "");
    String savedSsid = preferences.getString("wifi_ssid", "");
    String savedPass = preferences.getString("wifi_pass", "");

    if (savedUrl.length() > 8)  SERVER_BASE_URL = normalizeBaseUrl(savedUrl);
    if (savedSsid.length() > 0 && savedSsid != "YOUR_WIFI_NAME") activeSsid = savedSsid;
    if (savedPass.length() > 0 && savedPass != "YOUR_WIFI_PASSWORD" && savedPass != "12345678") {
        activePass = savedPass;
    } else {
        preferences.putString("wifi_ssid", activeSsid);
        preferences.putString("wifi_pass", activePass);
    }

    Serial.println("[CONFIG] Active Cloud Server: " + SERVER_BASE_URL);
    Serial.println("[CONFIG] Active Wi-Fi SSID  : " + activeSsid);
}

void connectWiFi() {
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.setSleep(false);
    WiFi.begin(activeSsid.c_str(), activePass.c_str());
    Serial.printf("[WIFI] Connecting to '%s'", activeSsid.c_str());

    unsigned long startWait = millis();
    while (WiFi.status() != WL_CONNECTED && (millis() - startWait < 12000)) {
        delay(350);
        Serial.print(".");
    }
    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("[WIFI] WiFi Connected! IP: " + WiFi.localIP().toString());
    } else {
        Serial.println("[WIFI] Connection pending — will retry automatically in loop.");
    }
}

void handleUsbSerialCommands() {
    while (Serial.available() > 0) {
        char c = (char)Serial.read();
        if (c == '\n' || c == '\r') {
            usbLineBuffer.trim();
            if (usbLineBuffer.startsWith("SET_URL:")) {
                String newUrl = normalizeBaseUrl(usbLineBuffer.substring(8));
                if (newUrl.startsWith("http://") || newUrl.startsWith("https://")) {
                    SERVER_BASE_URL = newUrl;
                    preferences.putString("server_url", SERVER_BASE_URL);
                    Serial.println("[NVS SAVED] SERVER_BASE_URL = " + SERVER_BASE_URL);
                } else {
                    Serial.println("[ERROR] URL must start with https:// or http://");
                }
            } else if (usbLineBuffer.startsWith("SET_WIFI:")) {
                String creds = usbLineBuffer.substring(9);
                int commaIdx = creds.indexOf(',');
                if (commaIdx > 0) {
                    activeSsid = creds.substring(0, commaIdx);
                    activePass = creds.substring(commaIdx + 1);
                    activeSsid.trim();
                    activePass.trim();
                    preferences.putString("wifi_ssid", activeSsid);
                    preferences.putString("wifi_pass", activePass);
                    Serial.println("[NVS SAVED] Wi-Fi updated. Reconnecting...");
                    WiFi.disconnect();
                    connectWiFi();
                } else {
                    Serial.println("[ERROR] Format: SET_WIFI:SSID,PASSWORD");
                }
            } else if (usbLineBuffer.equalsIgnoreCase("GET_CONFIG")) {
                Serial.println("[CONFIG] SERVER_BASE_URL = " + SERVER_BASE_URL);
                Serial.println("[CONFIG] WIFI_SSID       = " + activeSsid);
                Serial.println("[CONFIG] IP              = " + WiFi.localIP().toString());
            }
            usbLineBuffer = "";
        } else if (usbLineBuffer.length() < 200) {
            usbLineBuffer += c;
        }
    }
}

// ----------------------------------------------------------------------------
// 5. ARDUINO UNO UART TELEMETRY PARSER & COMMAND FORWARDER
// ----------------------------------------------------------------------------
float extractJsonFloat(const String& json, const char* key, float fallback) {
    int keyIdx = json.indexOf(key);
    if (keyIdx < 0) return fallback;
    int colonIdx = json.indexOf(':', keyIdx);
    if (colonIdx < 0) return fallback;
    String sub = json.substring(colonIdx + 1);
    sub.trim();
    return sub.toFloat();
}

bool extractJsonBool(const String& json, const char* key, bool fallback) {
    int keyIdx = json.indexOf(key);
    if (keyIdx < 0) return fallback;
    int colonIdx = json.indexOf(':', keyIdx);
    if (colonIdx < 0) return fallback;
    String sub = json.substring(colonIdx + 1);
    sub.trim();
    if (sub.startsWith("true"))  return true;
    if (sub.startsWith("false")) return false;
    return fallback;
}

String extractJsonString(const String& json, const char* key, String fallback) {
    int keyIdx = json.indexOf(key);
    if (keyIdx < 0) return fallback;
    int colonIdx = json.indexOf(':', keyIdx);
    if (colonIdx < 0) return fallback;
    int q1 = json.indexOf('\"', colonIdx);
    if (q1 < 0) return fallback;
    int q2 = json.indexOf('\"', q1 + 1);
    if (q2 < 0) return fallback;
    return json.substring(q1 + 1, q2);
}

void readUnoUartTelemetry() {
    while (Serial1.available() > 0) {
        char c = (char)Serial1.read();
        if (c == '\n' || c == '\r') {
            uartLineBuffer.trim();
            if (uartLineBuffer.startsWith("{") && uartLineBuffer.endsWith("}")) {
                cachedDistanceCm = extractJsonFloat(uartLineBuffer, "\"distance_cm\"", cachedDistanceCm);
                cachedWaterLeak  = extractJsonBool(uartLineBuffer, "\"water_leak\"", cachedWaterLeak);
                cachedLat        = extractJsonFloat(uartLineBuffer, "\"lat\"", cachedLat);
                cachedLon        = extractJsonFloat(uartLineBuffer, "\"lon\"", cachedLon);
                cachedBatteryV   = extractJsonFloat(uartLineBuffer, "\"battery_v\"", cachedBatteryV);
            }
            uartLineBuffer = "";
        } else if (uartLineBuffer.length() < 240) {
            uartLineBuffer += c;
        }
    }
}

void forwardCommandToUno(char cmd) {
    if (cmd == 'F' || cmd == 'B' || cmd == 'L' || cmd == 'R' || cmd == 'S') {
        if (cmd != lastForwardedCmd) {
            Serial1.write(cmd);
            Serial1.flush();
            lastForwardedCmd = cmd;
            Serial.printf("[UNO UART] Motor cmd -> '%c'\n", cmd);
        }
    }
}

void forwardSirenToUno(bool sirenOn) {
    if (sirenOn != lastSirenState) {
        char code = sirenOn ? 'A' : 'C';
        Serial1.write(code);
        Serial1.flush();
        lastSirenState = sirenOn;
        Serial.printf("[UNO UART] Siren -> %s ('%c')\n", sirenOn ? "ON" : "OFF", code);
    }
}

// ----------------------------------------------------------------------------
// 6. CLOUD HTTP CLIENT HELPERS (HTTPS & HTTP DOMAIN-AGNOSTIC)
// ----------------------------------------------------------------------------
bool beginHttpClient(HTTPClient& http, WiFiClientSecure& tlsClient, WiFiClient& plainClient, const String& fullUrl) {
    http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
    http.setTimeout(3000);
    if (fullUrl.startsWith("https://")) {
        tlsClient.setInsecure();
        return http.begin(tlsClient, fullUrl);
    }
    return http.begin(plainClient, fullUrl);
}

void postTelemetryAndSyncCommands() {
    if (WiFi.status() != WL_CONNECTED) return;

    WiFiClientSecure tlsClient;
    WiFiClient plainClient;
    HTTPClient http;

    String url = SERVER_BASE_URL + "/api/telemetry";
    if (!beginHttpClient(http, tlsClient, plainClient, url)) return;

    http.addHeader("Content-Type", "application/json");

    char jsonBody[220];
    snprintf(
        jsonBody,
        sizeof(jsonBody),
        "{\"distance_cm\":%.2f,\"water_leak\":%s,\"lat\":%.6f,\"lon\":%.6f,\"battery_v\":%.2f}",
        cachedDistanceCm,
        cachedWaterLeak ? "true" : "false",
        cachedLat,
        cachedLon,
        cachedBatteryV
    );

    int code = http.POST((uint8_t*)jsonBody, strlen(jsonBody));
    if (code == HTTP_CODE_OK) {
        Serial.printf("[CLOUD TELEMETRY] POST /api/telemetry -> %d OK\n", code);
        String resp = http.getString();
        String cmdStr = extractJsonString(resp, "\"command\"", "S");
        bool sirenOn    = extractJsonBool(resp, "\"siren\"", false);
        bool sosOn      = extractJsonBool(resp, "\"sos_active\"", false);
        bool disasterOn = extractJsonBool(resp, "\"disaster_active\"", false);

        if (cmdStr.length() >= 1) {
            forwardCommandToUno(cmdStr.charAt(0));
        }
        forwardSirenToUno(sirenOn || sosOn || disasterOn);
    } else if (code < 0) {
        Serial.printf("[CLOUD TELEMETRY] HTTP error: %s\n", http.errorToString(code).c_str());
    } else {
        Serial.printf("[CLOUD TELEMETRY] POST /api/telemetry -> %d\n", code);
    }
    http.end();
}

void postCameraFrame() {
    if (WiFi.status() != WL_CONNECTED) return;

    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) {
        Serial.println("[CAMERA] Frame capture failed.");
        return;
    }

    WiFiClientSecure tlsClient;
    WiFiClient plainClient;
    HTTPClient http;

    String url = SERVER_BASE_URL + "/api/esp32/frame";
    if (beginHttpClient(http, tlsClient, plainClient, url)) {
        http.addHeader("Content-Type", "image/jpeg");
        int code = http.POST(fb->buf, fb->len);
        if (code != HTTP_CODE_OK && code < 0) {
            Serial.printf("[CLOUD FRAME] HTTP error: %s\n", http.errorToString(code).c_str());
        }
        http.end();
    }

    esp_camera_fb_return(fb);
}

// ----------------------------------------------------------------------------
// 7. SETUP & MAIN LOOP
// ----------------------------------------------------------------------------
void setup() {
    WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);
    setCpuFrequencyMhz(160); // Low-power 160MHz to prevent USB cable brownouts
    delay(100);

    Serial.begin(115200);
    delay(400);
    Serial.println("\n=======================================================");
    Serial.println("  AquaNav ESP32-S3 Cloud Bridge (Domain-Agnostic)");
    Serial.println("  Commands: SET_URL:<url> | SET_WIFI:ssid,pass | GET_CONFIG");
    Serial.println("=======================================================");
    Serial.flush();

    Serial1.begin(UART_BAUD_RATE, SERIAL_8N1, UART_UNO_RX_PIN, UART_UNO_TX_PIN);

    loadPreferences();
    initCamera();
    connectWiFi();
}

void loop() {
    handleUsbSerialCommands();
    readUnoUartTelemetry();

    unsigned long now = millis();

    // Auto-reconnect Wi-Fi if dropped
    if (WiFi.status() != WL_CONNECTED) {
        static unsigned long lastReconnectAttempt = 0;
        if (now - lastReconnectAttempt > 10000) {
            lastReconnectAttempt = now;
            Serial.println("[WIFI] Reconnecting to " + activeSsid + "...");
            WiFi.disconnect();
            delay(100);
            WiFi.begin(activeSsid.c_str(), activePass.c_str());
        }
        delay(10);
        return;
    }

    // 1. Telemetry + Single-RTT Steering Sync
    if (now - lastTelemetryPostMs >= TELEMETRY_INTERVAL_MS) {
        lastTelemetryPostMs = now;
        postTelemetryAndSyncCommands();
    }

    // 2. QVGA Camera Frame Uplink
    if (now - lastFramePostMs >= FRAME_INTERVAL_MS) {
        lastFramePostMs = now;
        postCameraFrame();
    }

    delay(5);
}

