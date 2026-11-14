/*
 ==============================================================================
  AquaNav Autonomous Marine Surface Vessel - Arduino Uno Actuator Firmware
  Target Board : Arduino Uno R3 / R4 (ATmega328P / RA4M1)
  Framework    : Arduino AVR
  Baud Rate    : 115200 Baud (Hardware Serial UART to ESP32-S3)
 ==============================================================================
  Exact Physical Pinout:
    - L298N Dual H-Bridge Motor Driver:
        * ENA = D5 (Left Motor Speed PWM)
        * IN1 = D2 (Left Motor Direction 1)
        * IN2 = D3 (Left Motor Direction 2)
        * IN3 = D4 (Right Motor Direction 1)
        * IN4 = D7 (Right Motor Direction 2)
        * ENB = D6 (Right Motor Speed PWM)
    - HC-SR04 Ultrasonic Distance Sensor:
        * TRIG = D9 (Output)
        * ECHO = D8 (Input)
    - NEO-6M GPS Module (SoftwareSerial @ 9600 baud):
        * RX = D10 (Connects to GPS Module TX)
        * TX = D11 (Connects to GPS Module RX)
    - HW-038 Water Leak / Bilge Sensor:
        * Analog Out = A0 (Threshold: dry > 700, wet < 400)
    - 2-Pin Active Acoustic Siren Buzzer:
        * Positive (+) = D12
        * Negative (-) = GND
    - Status Indicator:
        * Built-in LED = D13
 ==============================================================================
*/

#include <Arduino.h>
#include <SoftwareSerial.h>

// ----------------------------------------------------------------------------
// 1. PIN DEFINITIONS
// ----------------------------------------------------------------------------
// L298N Motor Driver Pins
const int PIN_ENA = 5;
const int PIN_IN1 = 2;
const int PIN_IN2 = 3;
const int PIN_IN3 = 4;
const int PIN_IN4 = 7;
const int PIN_ENB = 6;

// HC-SR04 Ultrasonic Distance Sensor Pins
const int PIN_TRIG = 9;
const int PIN_ECHO = 8;

// NEO-6M GPS Module (SoftwareSerial)
const int PIN_GPS_RX = 10; // Connects to GPS TX
const int PIN_GPS_TX = 11; // Connects to GPS RX

// HW-038 Water Leak Sensor
const int PIN_WATER_LEAK = A0;
const int WATER_LEAK_THRESHOLD = 400; // Trigger when reading < 400

// 2-Pin Active Buzzer & LED Status
const int PIN_BUZZER = 12;
const int PIN_LED_STATUS = 13;

// SoftwareSerial instance for NEO-6M GPS
SoftwareSerial gpsSerial(PIN_GPS_RX, PIN_GPS_TX);

// ----------------------------------------------------------------------------
// 2. CONFIGURATION & STATE
// ----------------------------------------------------------------------------
const int SPEED_FORWARD = 230;  // Full forward propulsion PWM (0-255)
const int SPEED_TURN    = 210;  // Pivot turn PWM
const int SPEED_REVERSE = 180;  // Reverse PWM

const float OBSTACLE_COLLISION_THRESHOLD_CM = 25.0; // Collision stop if < 25 cm
const unsigned long TELEMETRY_INTERVAL_MS   = 500;  // 500ms cloud sync rate

char activeCommand = 'S';       // Default to Stop on startup until commanded
bool cloudSirenActive = false;
bool obstacleFailsafeActive = false;
bool waterLeakFailsafeActive = false;

unsigned long lastTelemetryTime = 0;
unsigned long lastBuzzerToggleTime = 0;
bool buzzerPulseState = false;

// GPS State (Fallback to Hyderabad Marine / Benchmark coordinates)
float currentLat = 17.3850;
float currentLon = 78.4867;
float currentBatteryV = 12.20;

// NMEA sentence parsing buffer
char nmeaBuffer[85];
uint8_t nmeaIdx = 0;

// ----------------------------------------------------------------------------
// 3. MOTOR DRIVER PRIMITIVES (L298N)
// ----------------------------------------------------------------------------
void applyMotorSpeeds(int speedLeft, int speedRight) {
    analogWrite(PIN_ENA, constrain(speedLeft, 0, 255));
    analogWrite(PIN_ENB, constrain(speedRight, 0, 255));
}

void motorsStop() {
    digitalWrite(PIN_IN1, LOW);
    digitalWrite(PIN_IN2, LOW);
    digitalWrite(PIN_IN3, LOW);
    digitalWrite(PIN_IN4, LOW);
    applyMotorSpeeds(0, 0);
}

void motorsForward() {
    digitalWrite(PIN_IN1, HIGH);
    digitalWrite(PIN_IN2, LOW);
    digitalWrite(PIN_IN3, HIGH);
    digitalWrite(PIN_IN4, LOW);
    applyMotorSpeeds(SPEED_FORWARD, SPEED_FORWARD);
}

void motorsReverse() {
    digitalWrite(PIN_IN1, LOW);
    digitalWrite(PIN_IN2, HIGH);
    digitalWrite(PIN_IN3, LOW);
    digitalWrite(PIN_IN4, HIGH);
    applyMotorSpeeds(SPEED_REVERSE, SPEED_REVERSE);
}

void motorsSpinLeft() {
    digitalWrite(PIN_IN1, LOW);
    digitalWrite(PIN_IN2, HIGH);
    digitalWrite(PIN_IN3, HIGH);
    digitalWrite(PIN_IN4, LOW);
    applyMotorSpeeds(SPEED_TURN, SPEED_TURN);
}

void motorsSpinRight() {
    digitalWrite(PIN_IN1, HIGH);
    digitalWrite(PIN_IN2, LOW);
    digitalWrite(PIN_IN3, LOW);
    digitalWrite(PIN_IN4, HIGH);
    applyMotorSpeeds(SPEED_TURN, SPEED_TURN);
}

void executeMotorCommand(char cmd) {
    // Hardware Safety Overrides:
    // If obstacle is under 25cm, forward and turning propulsion are halted to prevent collisions.
    if (obstacleFailsafeActive && (cmd == 'F' || cmd == 'L' || cmd == 'R')) {
        motorsStop();
        return;
    }

    // If water leak is detected, cut all motor power immediately
    if (waterLeakFailsafeActive) {
        motorsStop();
        return;
    }

    switch (cmd) {
        case 'F': motorsForward();   break;
        case 'B': motorsReverse();   break;
        case 'L': motorsSpinLeft();  break;
        case 'R': motorsSpinRight(); break;
        case 'S':
        default:  motorsStop();      break;
    }
}

// ----------------------------------------------------------------------------
// 4. SENSORS (ULTRASONIC, WATER LEAK & GPS)
// ----------------------------------------------------------------------------
float sampleUltrasonicDistanceCm() {
    digitalWrite(PIN_TRIG, LOW);
    delayMicroseconds(2);
    digitalWrite(PIN_TRIG, HIGH);
    delayMicroseconds(10);
    digitalWrite(PIN_TRIG, LOW);

    // Timeout 25000us ~ 4.2m
    unsigned long duration = pulseIn(PIN_ECHO, HIGH, 25000UL);
    if (duration == 0) {
        return 999.0;
    }

    float dist = (duration * 0.0343) / 2.0;
    if (dist <= 0.5) {
        return 999.0;
    }
    return dist;
}

bool sampleWaterLeakSensor() {
    int rawVal = analogRead(PIN_WATER_LEAK);
    return (rawVal < WATER_LEAK_THRESHOLD);
}

// Lightweight NMEA GPRMC / GPGGA coordinate parser
float parseNmeaCoord(const char* s, char hemi) {
    float raw = atof(s);
    int deg = (int)(raw / 100.0);
    float minutes = raw - (deg * 100.0);
    float decimal = (float)deg + (minutes / 60.0);
    if (hemi == 'S' || hemi == 'W') {
        decimal = -decimal;
    }
    return decimal;
}

void parseGpsSentence(const char* nmea) {
    // Check for $GPRMC sentence: $GPRMC,time,status,lat,N,lon,E,...
    if (strncmp(nmea, "$GPRMC", 6) == 0 || strncmp(nmea, "$GNRMC", 6) == 0) {
        char buf[85];
        strncpy(buf, nmea, sizeof(buf) - 1);
        buf[sizeof(buf) - 1] = '\0';

        char* p = buf;
        int field = 0;
        char* tokens[12];
        while (p && field < 12) {
            tokens[field++] = p;
            p = strchr(p, ',');
            if (p) {
                *p = '\0';
                p++;
            }
        }

        // Field 2 is status ('A'=valid fix, 'V'=warning)
        if (field >= 7 && tokens[2] && tokens[2][0] == 'A') {
            if (strlen(tokens[3]) > 4 && strlen(tokens[5]) > 4) {
                char latHemi = tokens[4] ? tokens[4][0] : 'N';
                char lonHemi = tokens[6] ? tokens[6][0] : 'E';
                float parsedLat = parseNmeaCoord(tokens[3], latHemi);
                float parsedLon = parseNmeaCoord(tokens[5], lonHemi);
                if (abs(parsedLat) > 0.01 && abs(parsedLon) > 0.01) {
                    currentLat = parsedLat;
                    currentLon = parsedLon;
                }
            }
        }
    }
}

void readGpsStream() {
    while (gpsSerial.available() > 0) {
        char c = (char)gpsSerial.read();
        if (c == '$') {
            nmeaIdx = 0;
            nmeaBuffer[nmeaIdx++] = c;
        } else if (nmeaIdx > 0 && nmeaIdx < sizeof(nmeaBuffer) - 1) {
            if (c == '\r' || c == '\n') {
                nmeaBuffer[nmeaIdx] = '\0';
                parseGpsSentence(nmeaBuffer);
                nmeaIdx = 0;
            } else {
                nmeaBuffer[nmeaIdx++] = c;
            }
        }
    }
}

// ----------------------------------------------------------------------------
// 5. BUZZER & ACOUSTIC SIREN LOGIC
// ----------------------------------------------------------------------------
void updateBuzzer() {
    unsigned long now = millis();

    // Priority 1: Water leak emergency -> fast continuous alarm
    if (waterLeakFailsafeActive) {
        digitalWrite(PIN_BUZZER, HIGH);
        digitalWrite(PIN_LED_STATUS, HIGH);
        return;
    }

    // Priority 2: Obstacle collision fail-safe -> intermittent warning chirps
    if (obstacleFailsafeActive) {
        if (now - lastBuzzerToggleTime >= 120) {
            lastBuzzerToggleTime = now;
            buzzerPulseState = !buzzerPulseState;
            digitalWrite(PIN_BUZZER, buzzerPulseState ? HIGH : LOW);
            digitalWrite(PIN_LED_STATUS, buzzerPulseState ? HIGH : LOW);
        }
        return;
    }

    // Priority 3: Cloud siren / SOS command active -> pulsing siren pattern
    if (cloudSirenActive) {
        if (now - lastBuzzerToggleTime >= 250) {
            lastBuzzerToggleTime = now;
            buzzerPulseState = !buzzerPulseState;
            digitalWrite(PIN_BUZZER, buzzerPulseState ? HIGH : LOW);
            digitalWrite(PIN_LED_STATUS, buzzerPulseState ? HIGH : LOW);
        }
        return;
    }

    // Default: Buzzer off
    digitalWrite(PIN_BUZZER, LOW);
    digitalWrite(PIN_LED_STATUS, (activeCommand != 'S') ? HIGH : LOW);
}

// ----------------------------------------------------------------------------
// 6. SERIAL UART COMMAND HANDLER & TELEMETRY STREAMER
// ----------------------------------------------------------------------------
void handleSerialCommands() {
    while (Serial.available() > 0) {
        char inChar = (char)Serial.read();

        // Directional steering commands
        if (inChar == 'F' || inChar == 'B' || inChar == 'L' || inChar == 'R' || inChar == 'S') {
            activeCommand = inChar;
            executeMotorCommand(activeCommand);
        }
        // Siren & Alarm commands from Cloud
        else if (inChar == 'A') {
            cloudSirenActive = true;
        } else if (inChar == 'C') {
            cloudSirenActive = false;
        }
    }
}

void streamTelemetryJson(float distanceCm, bool isLeak) {
    // Single compact JSON line for ESP32-S3 UART Bridge (115200 baud)
    Serial.print(F("{\"distance_cm\":"));
    Serial.print(distanceCm, 1);
    Serial.print(F(",\"water_leak\":"));
    Serial.print(isLeak ? F("true") : F("false"));
    Serial.print(F(",\"lat\":"));
    Serial.print(currentLat, 4);
    Serial.print(F(",\"lon\":"));
    Serial.print(currentLon, 4);
    Serial.print(F(",\"battery_v\":"));
    Serial.print(currentBatteryV, 1);
    Serial.println(F("}"));
}

// ----------------------------------------------------------------------------
// 7. SETUP & MAIN EXECUTION LOOP
// ----------------------------------------------------------------------------
void setup() {
    // Hardware Serial to ESP32-S3 Bridge at 115200 baud
    Serial.begin(115200);

    // SoftwareSerial to NEO-6M GPS at 9600 baud
    gpsSerial.begin(9600);

    // Initialize Motor Driver Pins
    pinMode(PIN_ENA, OUTPUT);
    pinMode(PIN_IN1, OUTPUT);
    pinMode(PIN_IN2, OUTPUT);
    pinMode(PIN_IN3, OUTPUT);
    pinMode(PIN_IN4, OUTPUT);
    pinMode(PIN_ENB, OUTPUT);

    // Initialize Sensors & Indicators
    pinMode(PIN_TRIG, OUTPUT);
    pinMode(PIN_ECHO, INPUT);
    pinMode(PIN_WATER_LEAK, INPUT_PULLUP);
    pinMode(PIN_BUZZER, OUTPUT);
    pinMode(PIN_LED_STATUS, OUTPUT);

    // Initial safe state
    motorsStop();
    digitalWrite(PIN_BUZZER, LOW);
    digitalWrite(PIN_LED_STATUS, LOW);

    // Two short power-on confirmation chirps
    digitalWrite(PIN_BUZZER, HIGH);
    delay(60);
    digitalWrite(PIN_BUZZER, LOW);
    delay(60);
    digitalWrite(PIN_BUZZER, HIGH);
    delay(60);
    digitalWrite(PIN_BUZZER, LOW);
}

void loop() {
    // 1. Process incoming commands from ESP32-S3 over Hardware Serial (115200 baud)
    handleSerialCommands();

    // 2. Read GPS stream from NEO-6M
    readGpsStream();

    // 3. Update acoustic buzzer & failsafe alerts
    updateBuzzer();

    // 4. Periodic sensor evaluation & JSON telemetry broadcast
    unsigned long now = millis();
    if (now - lastTelemetryTime >= TELEMETRY_INTERVAL_MS) {
        lastTelemetryTime = now;

        float distanceCm = sampleUltrasonicDistanceCm();
        bool isLeak      = sampleWaterLeakSensor();

        // Evaluate ultrasonic obstacle collision stop (< 25 cm)
        if (distanceCm > 2.0 && distanceCm < OBSTACLE_COLLISION_THRESHOLD_CM) {
            obstacleFailsafeActive = true;
            if (activeCommand == 'F' || activeCommand == 'L' || activeCommand == 'R') {
                motorsStop();
            }
        } else {
            obstacleFailsafeActive = false;
        }

        // Evaluate bilge water leak
        if (isLeak) {
            waterLeakFailsafeActive = true;
            motorsStop();
        } else {
            waterLeakFailsafeActive = false;
        }

        // Resume motion if failsafes are clear and command is active
        if (!obstacleFailsafeActive && !waterLeakFailsafeActive && activeCommand != 'S') {
            executeMotorCommand(activeCommand);
        }

        // Stream JSON line to ESP32-S3
        streamTelemetryJson(distanceCm, isLeak);
    }
}
