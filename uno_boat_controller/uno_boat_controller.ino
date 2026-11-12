/*
 ==============================================================================
  AquaNav Autonomous Ground Station - Arduino Uno Propulsion & Actuator Firmware
  Target Board : Arduino Uno R3 / R4 (ATmega328P / RA4M1)
  Motor Driver : L298N Dual H-Bridge Driver
  Sensors      : HC-SR04 Ultrasonic Rangefinder & Hull Water Leak Sensor
  Acoustic     : NPN Transistor-Driven Buzzer (Pin 9)
 ==============================================================================
  Key Behavior:
    1. AUTO-START FORWARD ON POWER-UP:
       The instant power is applied, setup() initializes pins, emits two short
       audible confirmation chirps, and immediately commands both motors to
       rotate FORWARD at full driving torque (PWM 230).
    2. NO IDLE SERIAL TIMEOUT:
       Motors run continuously forward without requiring a heartbeat or UART
       poll from the ESP32-S3 or laptop. They only stop if explicitly sent 'S'
       or if a physical safety failsafe triggers.
    3. REAL-TIME SERIAL OVERRIDE:
       Listens on Serial (115200 baud) for manual D-Pad or AI vision commands
       ('F', 'B', 'L', 'R', 'S', 'A', 'C') to change direction at any time.
    4. ROBUST HARDWARE SAFETY FAILSAFE:
       - HC-SR04 halts forward motion ONLY on valid obstacle readings (2 < dist < 25 cm).
         Disconnected, 0 cm, or timeout readings are ignored to prevent false stops.
       - As soon as the obstacle clears (dist >= 25 cm), forward motion automatically resumes.
       - Water leak detection immediately halts motors and sounds siren.
    5. TELEMETRY:
       Streams 10 Hz JSON telemetry back over UART: {"distance_cm": XX.X, "water_leak": bool, "cmd": "F"}
 ==============================================================================
*/

// ==============================================================================
// 1. PIN DEFINITIONS
// ==============================================================================

// L298N Dual H-Bridge Motor Driver
// Left Motor (Motor A)
const int PIN_ENA = 5;    // PWM Speed (0 - 255)
const int PIN_IN1 = 2;    // Left Motor Direction 1
const int PIN_IN2 = 3;    // Left Motor Direction 2

// Right Motor (Motor B)
const int PIN_ENB = 6;    // PWM Speed (0 - 255)
const int PIN_IN3 = 4;    // Right Motor Direction 1
const int PIN_IN4 = 7;    // Right Motor Direction 2

// HC-SR04 Ultrasonic Distance Sensor
const int PIN_TRIG = 8;
const int PIN_ECHO = 11;

// Acoustic Buzzer (Driven via NPN 2N2222 Transistor on PWM Pin 9)
const int PIN_BUZZER = 9;

// Hull Water Leak Sensor (Connected to A0 analog or digital pin)
const int PIN_WATER_LEAK = A0;
const int WATER_LEAK_ANALOG_THRESHOLD = 300; // Trigger if analog (dry > 800, wet < 300)

// Built-in LED for Activity Indication
const int PIN_LED_HEARTBEAT = 13;

// ==============================================================================
// 2. MOTOR SPEED & CONFIGURATION PARAMETERS
// ==============================================================================
const int MOTOR_SPEED_FORWARD = 230;  // Full forward propulsion torque (0-255)
const int MOTOR_SPEED_TURN    = 210;  // PWM for pivot turns
const int MOTOR_SPEED_SLOW    = 180;  // PWM for reverse maneuvering

// Active Motor State: Default to 'F' (Forward) so boat starts moving immediately
char currentCommand = 'F';
char previousCommand = 'F';

// Non-blocking Timing
unsigned long lastTelemetryTime = 0;
const unsigned long TELEMETRY_INTERVAL_MS = 100; // 10 Hz telemetry stream

unsigned long lastBuzzerToggleTime = 0;
bool buzzerState = false;
bool alarmSirenActive = false;

// Hardware Emergency Stop Flag
bool hardwareSafetyStop = false;

// ==============================================================================
// 3. MOTOR DRIVER CONTROL FUNCTIONS (L298N)
// ==============================================================================
void setMotorSpeeds(int speedLeft, int speedRight) {
    analogWrite(PIN_ENA, constrain(speedLeft, 0, 255));
    analogWrite(PIN_ENB, constrain(speedRight, 0, 255));
}

void moveForward() {
    // Both motors rotate FORWARD with full driving torque
    digitalWrite(PIN_IN1, HIGH);
    digitalWrite(PIN_IN2, LOW);
    digitalWrite(PIN_IN3, HIGH);
    digitalWrite(PIN_IN4, LOW);
    setMotorSpeeds(MOTOR_SPEED_FORWARD, MOTOR_SPEED_FORWARD);
}

void moveReverse() {
    digitalWrite(PIN_IN1, LOW);
    digitalWrite(PIN_IN2, HIGH);
    digitalWrite(PIN_IN3, LOW);
    digitalWrite(PIN_IN4, HIGH);
    setMotorSpeeds(MOTOR_SPEED_SLOW, MOTOR_SPEED_SLOW);
}

void spinLeft() {
    // Pivot turn left: left motor reverse, right motor forward
    digitalWrite(PIN_IN1, LOW);
    digitalWrite(PIN_IN2, HIGH);
    digitalWrite(PIN_IN3, HIGH);
    digitalWrite(PIN_IN4, LOW);
    setMotorSpeeds(MOTOR_SPEED_TURN, MOTOR_SPEED_TURN);
}

void spinRight() {
    // Pivot turn right: left motor forward, right motor reverse
    digitalWrite(PIN_IN1, HIGH);
    digitalWrite(PIN_IN2, LOW);
    digitalWrite(PIN_IN3, LOW);
    digitalWrite(PIN_IN4, HIGH);
    setMotorSpeeds(MOTOR_SPEED_TURN, MOTOR_SPEED_TURN);
}

void stopMotors() {
    digitalWrite(PIN_IN1, LOW);
    digitalWrite(PIN_IN2, LOW);
    digitalWrite(PIN_IN3, LOW);
    digitalWrite(PIN_IN4, LOW);
    setMotorSpeeds(0, 0);
}

// ==============================================================================
// 4. ACOUSTIC BUZZER CONTROL (Pin 9)
// ==============================================================================
void triggerShortChirp() {
    // 60ms quick confirmation beep on command / direction change
    tone(PIN_BUZZER, 2200, 60);
}

void triggerStartupChirps() {
    // Two distinct confirmation chirps when Arduino boots & motors engage
    tone(PIN_BUZZER, 2200, 70);
    delay(110);
    tone(PIN_BUZZER, 2600, 90);
    delay(130);
}

void updateAcousticSiren(bool hazardPresent) {
    if (hazardPresent || alarmSirenActive) {
        // Alternating two-tone emergency alarm (1800Hz / 2600Hz)
        unsigned long now = millis();
        if (now - lastBuzzerToggleTime >= 120) {
            lastBuzzerToggleTime = now;
            buzzerState = !buzzerState;
            if (buzzerState) {
                tone(PIN_BUZZER, 2600);
            } else {
                tone(PIN_BUZZER, 1800);
            }
        }
    } else {
        // Silence buzzer if no active hazard or manual alarm
        if (buzzerState) {
            noTone(PIN_BUZZER);
            buzzerState = false;
        }
    }
}

// ==============================================================================
// 5. SENSOR SAMPLING (HC-SR04 & WATER LEAK)
// ==============================================================================
float readUltrasonicDistance() {
    // Trigger ultrasonic burst
    digitalWrite(PIN_TRIG, LOW);
    delayMicroseconds(2);
    digitalWrite(PIN_TRIG, HIGH);
    delayMicroseconds(10);
    digitalWrite(PIN_TRIG, LOW);

    // Read echo pulse duration (25ms timeout ~ 420cm max range)
    unsigned long duration = pulseIn(PIN_ECHO, HIGH, 25000UL);
    if (duration == 0) {
        return 999.0; // Out of range, sensor timeout, or disconnected sensor
    }

    // Distance calculation: sound speed = 343 m/s = 0.0343 cm/us -> (duration * 0.0343) / 2
    float distance_cm = (duration * 0.0343) / 2.0;

    // Reject invalid zero/negative readings
    if (distance_cm <= 0.0) {
        return 999.0;
    }

    return distance_cm;
}

bool readWaterLeakSensor() {
    int analogVal = analogRead(PIN_WATER_LEAK);
    bool isLeak = (analogVal < WATER_LEAK_ANALOG_THRESHOLD);
    return isLeak;
}

// ==============================================================================
// 6. SETUP & MAIN EXECUTION LOOP
// ==============================================================================
void setup() {
    // Initialize UART to ESP32-S3 Bridge or USB Serial (115200 Baud)
    Serial.begin(115200);

    // Initialize Motor Driver Pins as OUTPUT
    pinMode(PIN_ENA, OUTPUT);
    pinMode(PIN_IN1, OUTPUT);
    pinMode(PIN_IN2, OUTPUT);
    pinMode(PIN_IN3, OUTPUT);
    pinMode(PIN_IN4, OUTPUT);
    pinMode(PIN_ENB, OUTPUT);

    // Initialize Sensor Pins
    pinMode(PIN_TRIG, OUTPUT);
    pinMode(PIN_ECHO, INPUT);
    pinMode(PIN_WATER_LEAK, INPUT);

    // Initialize Buzzer & Status LED
    pinMode(PIN_BUZZER, OUTPUT);
    digitalWrite(PIN_BUZZER, LOW);
    pinMode(PIN_LED_HEARTBEAT, OUTPUT);

    // Emit two short audible startup chirps confirming boot & motor engagement
    triggerStartupChirps();

    // AUTO-START FORWARD ON POWER-UP:
    // Engage full forward propulsion immediately without waiting for serial commands
    currentCommand = 'F';
    previousCommand = 'F';
    moveForward();
}

void loop() {
    // --------------------------------------------------------------------------
    // 1. Process Incoming Serial Commands (ESP32 Bridge or USB Dashboard)
    // --------------------------------------------------------------------------
    while (Serial.available() > 0) {
        char cmd = (char)Serial.read();

        // Skip whitespace, newlines, and carriage returns
        if (cmd == '\r' || cmd == '\n' || cmd == ' ' || cmd == '\t') {
            continue;
        }

        // Normalize to uppercase
        if (cmd >= 'a' && cmd <= 'z') {
            cmd = cmd - 'a' + 'A';
        }

        if (cmd == 'F' || cmd == 'B' || cmd == 'L' || cmd == 'R' || cmd == 'S' || cmd == 'A' || cmd == 'C') {
            if (cmd == 'A') {
                alarmSirenActive = true;
            } else if (cmd == 'C') {
                alarmSirenActive = false;
                noTone(PIN_BUZZER);
            } else {
                if (cmd != currentCommand) {
                    previousCommand = currentCommand;
                    currentCommand = cmd;
                    triggerShortChirp();
                }
            }
        }
    }

    // --------------------------------------------------------------------------
    // 2. Sample Sensors (Ultrasonic & Water Leak) & Evaluate Safety Failsafe
    // --------------------------------------------------------------------------
    unsigned long now = millis();
    if (now - lastTelemetryTime >= TELEMETRY_INTERVAL_MS) {
        lastTelemetryTime = now;

        float distance = readUltrasonicDistance();
        bool waterLeak = readWaterLeakSensor();

        // Safety Failsafe:
        // Proximity Hazard ONLY if valid distance is strictly between 2 cm and 25 cm.
        // Disconnected sensor (999 cm or 0 cm) does NOT trigger a false emergency halt.
        bool proximityHazard = (distance > 2.0 && distance < 25.0);
        bool hardwareHazard = waterLeak || proximityHazard;

        if (hardwareHazard) {
            hardwareSafetyStop = true;
        } else {
            // Obstacle cleared or no water leak -> automatically clear safety halt
            hardwareSafetyStop = false;
        }

        // Update acoustic emergency siren
        updateAcousticSiren(hardwareHazard);

        // ----------------------------------------------------------------------
        // 3. Transmit JSON Telemetry String to ESP32 UART (10 Hz)
        // ----------------------------------------------------------------------
        Serial.print("{\"distance_cm\":");
        Serial.print(distance, 1);
        Serial.print(",\"water_leak\":");
        Serial.print(waterLeak ? "true" : "false");
        Serial.print(",\"cmd\":\"");
        Serial.print(currentCommand);
        Serial.println("\"}");

        // Toggle Heartbeat LED
        digitalWrite(PIN_LED_HEARTBEAT, !digitalRead(PIN_LED_HEARTBEAT));
    }

    // --------------------------------------------------------------------------
    // 4. Execute Motor Actuation (Runs continuously; auto-resumes once obstacle clears)
    // --------------------------------------------------------------------------
    if (hardwareSafetyStop) {
        stopMotors();
    } else {
        switch (currentCommand) {
            case 'F':
                moveForward();
                break;
            case 'B':
                moveReverse();
                break;
            case 'L':
                spinLeft();
                break;
            case 'R':
                spinRight();
                break;
            case 'S':
            default:
                stopMotors();
                break;
        }
    }
}

