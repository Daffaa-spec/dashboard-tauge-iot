/*
  Tauge IoT — ESP32, SHT30, XY-MOS and Firebase Realtime Database

  DEMO_MODE = 1: sends simulated sensor values; never powers the pump pin.
  DEMO_MODE = 0: reads SHT30 and enables the pump output on GPIO25.

  Automatic watering uses a dashboard-configurable timer because this project
  has no soil-moisture sensor. SHT30 measures air temperature and relative humidity.

  Paths used by the dashboard:
  devices/esp32-01/telemetry/{temperature,humidity,timestamp}
  devices/esp32-01/control/{mode,pump,autoPaused}
  devices/esp32-01/status/{online,lastSeen}
  devices/esp32-01/history/{pushId}/{temperature,humidity,pump,timestamp}
*/

#define ENABLE_USER_AUTH
#define ENABLE_DATABASE
#define DEMO_MODE 0

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <FirebaseClient.h>
#include <FirebaseJson.h>
#include <WebServer.h>
#include <Update.h>
#include <Wire.h>
#include <Adafruit_SHT31.h>
#include <math.h>
#include <time.h>

#include "firebase_secrets.h"  // Copy firebase_secrets.h.example and fill it in.
#include "firebase_root_ca.h"

#ifndef OTA_PASSWORD
#define OTA_PASSWORD "GANTI_PASSWORD_OTA_UNIK"
#endif

// ------------------------- Hardware -------------------------
constexpr uint8_t PUMP_PIN = 25;
constexpr uint8_t SHT30_SDA_PIN = 21;
constexpr uint8_t SHT30_SCL_PIN = 22;
constexpr uint32_t PUMP_PWM_FREQUENCY_HZ = 1000;
constexpr uint8_t PUMP_PWM_RESOLUTION_BITS = 8;
constexpr uint32_t PUMP_PWM_MAX_DUTY = (1UL << PUMP_PWM_RESOLUTION_BITS) - 1;
constexpr uint8_t PUMP_SPEED_PERCENT = 100;

// ------------------------- Timing -------------------------
constexpr uint32_t SENSOR_INTERVAL_MS = 1000;
constexpr uint32_t CONTROL_POLL_MS = 5000;
constexpr uint32_t TELEMETRY_INTERVAL_MS = 2000;
constexpr uint32_t HISTORY_INTERVAL_MS = 60000;
constexpr uint32_t STATUS_INTERVAL_MS = 15000;
// FirebaseClient's default async queue on ESP32 is 10 tasks. Keep background
// traffic low and reserve queue capacity for control and pump state changes.
constexpr uint8_t FIREBASE_BACKGROUND_QUEUE_LIMIT = 4;
constexpr uint8_t FIREBASE_CONTROL_QUEUE_LIMIT = 7;
constexpr uint32_t WIFI_RETRY_MS = 15000;
constexpr uint32_t SENSOR_RETRY_MS = 30000;
constexpr uint32_t HARD_PUMP_LIMIT_MS = 10000;
constexpr uint32_t DAY_MS = 24UL * 60UL * 60UL * 1000UL;
constexpr uint8_t WATERING_HISTORY_CAPACITY = 8;

#if DEMO_MODE
constexpr uint32_t MIN_WATERING_GAP_MS = 0;
#else
constexpr uint32_t MIN_WATERING_GAP_MS = 180UL * 60UL * 1000UL;
#endif

constexpr uint8_t AUTO_INTERVAL_HOURS = 3;
constexpr uint8_t PUMP_DURATION_SECONDS = 10;
constexpr char FIRMWARE_VERSION[] = "1.0.0";

constexpr time_t MIN_VALID_EPOCH = 1700000000;

// ------------------------- Firebase -------------------------
const String DEVICE_PATH = "/devices/esp32-01";
const String TELEMETRY_PATH = DEVICE_PATH + "/telemetry";
const String CONTROL_PATH = DEVICE_PATH + "/control";
const String STATUS_PATH = DEVICE_PATH + "/status";
const String HISTORY_PATH = DEVICE_PATH + "/history";

UserAuth userAuth(FIREBASE_API_KEY, FIREBASE_USER_EMAIL, FIREBASE_USER_PASSWORD);
FirebaseApp firebaseApp;
WiFiClientSecure sslClient;
using AsyncClient = AsyncClientClass;
AsyncClient firebaseClient(sslClient);
RealtimeDatabase Database;
WebServer otaServer(80);

void onFirebaseResult(AsyncResult &result);
void onControlResult(AsyncResult &result);

// ------------------------- Device state -------------------------
Adafruit_SHT31 sht30;

bool sensorReady = false;
bool sensorOK = false;
bool pumpRunning = false;
bool manualPumpCycle = false;
bool pumpPwmReady = false;
bool autoEnabled = true;
bool autoPaused = true;
bool lastPumpRequest = false;

bool firebaseStarted = false;
bool safePumpResetPending = false;
bool safePumpResetComplete = false;
bool controlPollPending = false;
bool timeSyncStarted = false;
bool otaUpdateInProgress = false;
bool otaUploadAuthorized = false;
bool otaUploadFinished = false;
String otaUploadError;

float temperatureC = NAN;
float humidityRH = NAN;

uint32_t pumpStartedAt = 0;
uint32_t lastWateringAt = 0;
uint32_t scheduleStartedAt = 0;
uint32_t lastSensorReadAt = 0;
uint32_t lastSensorAttemptAt = 0;
uint32_t lastControlPollAt = 0;
uint32_t lastTelemetryAt = 0;
uint32_t lastHistoryAt = 0;
uint32_t lastStatusAt = 0;
uint32_t lastWiFiAttemptAt = 0;
uint32_t lastQueueWarningAt = 0;

uint32_t wateringTimesMs[WATERING_HISTORY_CAPACITY] = {0};
uint8_t wateringCount = 0;
uint8_t wateringIndex = 0;

uint32_t wateringIntervalMs() {
#if DEMO_MODE
  return 60UL * 1000UL;
#else
  return (uint32_t)AUTO_INTERVAL_HOURS * 60UL * 60UL * 1000UL;
#endif
}

uint32_t pumpRunDurationMs() {
#if DEMO_MODE
  return 1000UL;
#else
  return (uint32_t)PUMP_DURATION_SECONDS * 1000UL;
#endif
}

uint8_t maxWateringsPerDay() {
#if DEMO_MODE
  return WATERING_HISTORY_CAPACITY;
#else
  return 24 / AUTO_INTERVAL_HOURS;
#endif
}

// ------------------------- Time and safety helpers -------------------------
uint64_t nowEpochMs() {
  const time_t now = time(nullptr);
  return now >= MIN_VALID_EPOCH ? (uint64_t)now * 1000ULL : 0;
}

void resetAutomaticScheduleClock(uint32_t nowMillis) {
  scheduleStartedAt = nowMillis;
}

uint8_t wateringsInLast24Hours(uint32_t now) {
#if DEMO_MODE
  (void)now;
  return 0;
#else
  uint8_t count = 0;
  for (uint8_t i = 0; i < wateringCount; ++i) {
    if ((uint32_t)(now - wateringTimesMs[i]) < DAY_MS) {
      ++count;
    }
  }
  return count;
#endif
}

bool wateringAllowed(uint32_t now, bool manual) {
  if (pumpRunning) {
    return false;
  }

#if !DEMO_MODE
  if (!manual && lastWateringAt != 0 &&
      (uint32_t)(now - lastWateringAt) < MIN_WATERING_GAP_MS) {
    Serial.println("[SAFETY] Jeda antar siram belum terpenuhi.");
    return false;
  }
  if (wateringsInLast24Hours(now) >= maxWateringsPerDay()) {
    Serial.println("[SAFETY] Batas siram 24 jam tercapai.");
    return false;
  }
  if (!manual && !sensorOK) {
    Serial.println("[SAFETY] Sensor offline; siram otomatis dijeda.");
    return false;
  }
#else
  (void)now;
  (void)manual;
#endif
  return true;
}

void writePumpState(bool state) {
  if (!firebaseApp.ready()) {
    return;
  }
  Database.set<bool>(firebaseClient, CONTROL_PATH + "/pump", state,
                     onFirebaseResult, "pumpState");
}

bool writePumpPwm(bool enabled) {
#if DEMO_MODE
  (void)enabled;
  return true;
#else
  if (!pumpPwmReady) {
    return false;
  }

  // Locked output: pump ON is always 100% duty; OFF is exactly 0%.
  const uint32_t duty = enabled ? PUMP_PWM_MAX_DUTY : 0;
  return ledcWrite(PUMP_PIN, duty);
#endif
}

void publishPumpHistoryEvent(bool state, bool manual) {
  if (!firebaseApp.ready()) {
    return;
  }

  const uint64_t timestamp = nowEpochMs();
  if (timestamp == 0) {
    return;
  }

  const float loggedTemperature = sensorOK ? temperatureC : 0.0f;
  const float loggedHumidity = sensorOK ? humidityRH : 0.0f;
  char json[210];
  snprintf(json, sizeof(json),
           "{\"temperature\":%.2f,\"humidity\":%.2f,\"pump\":%s,\"event\":\"pump\",\"mode\":\"%s\",\"timestamp\":%llu}",
           loggedTemperature, loggedHumidity, state ? "true" : "false",
           manual ? "manual" : "auto",
           (unsigned long long)timestamp);
  Database.push<object_t>(firebaseClient, HISTORY_PATH, object_t(json),
                          onFirebaseResult, "pumpHistoryEvent");
}

bool startWatering(const char *reason, bool manual) {
  const uint32_t now = millis();
  if (!wateringAllowed(now, manual)) {
    return false;
  }

#if !DEMO_MODE
  if (!writePumpPwm(true)) {
    Serial.println("[POMPA] PWM belum siap; pompa tidak dinyalakan.");
    return false;
  }
#endif

  pumpRunning = true;
  manualPumpCycle = manual;
  pumpStartedAt = now;
  lastWateringAt = now;
  resetAutomaticScheduleClock(now);

#if !DEMO_MODE
  wateringTimesMs[wateringIndex] = now;
  wateringIndex = (wateringIndex + 1) % WATERING_HISTORY_CAPACITY;
  if (wateringCount < WATERING_HISTORY_CAPACITY) {
    ++wateringCount;
  }
#endif

  writePumpState(true);
  publishPumpHistoryEvent(true, manual);
  Serial.printf("[%s] Mulai siram: %s (%lu ms)\n",
                DEMO_MODE ? "DEMO" : "POMPA", reason,
                (unsigned long)pumpRunDurationMs());
  return true;
}

void stopWatering(const char *reason) {
  if (!pumpRunning) {
    return;
  }
  const bool wasManualCycle = manualPumpCycle;

#if !DEMO_MODE
  if (!writePumpPwm(false)) {
    // Fail-safe fallback if LEDC reports an error while stopping the pump.
    ledcDetach(PUMP_PIN);
    pinMode(PUMP_PIN, OUTPUT);
    digitalWrite(PUMP_PIN, LOW);
    pumpPwmReady = false;
  }
#endif

  pumpRunning = false;
  manualPumpCycle = false;
  writePumpState(false);
  publishPumpHistoryEvent(false, wasManualCycle);
  Serial.printf("[POMPA] Mati: %s\n", reason);
}

void applyRemoteControl(const String &remoteMode, bool requestedPump,
                        bool requestedAutoPaused) {
  const bool wasPumpRequested = lastPumpRequest;
  autoPaused = requestedAutoPaused;
  const bool shouldAutoRun = remoteMode != "manual" && !autoPaused;
  if (autoEnabled != shouldAutoRun) {
    autoEnabled = shouldAutoRun;
    if (autoEnabled) {
      if (lastWateringAt == 0) {
        resetAutomaticScheduleClock(millis());
      }
      Serial.println("[AUTO] Jadwal otomatis dilanjutkan.");
    } else {
      Serial.println("[AUTO] Jadwal otomatis dijeda/dinonaktifkan.");
    }
  }

  if (!autoEnabled) {
    if (requestedPump && !wasPumpRequested) {
      startWatering("Perintah dashboard", true);
    } else if (!requestedPump && wasPumpRequested && manualPumpCycle) {
      stopWatering("Perintah berhenti dari dashboard");
    }
  }

  lastPumpRequest = requestedPump;
}

// ------------------------- Sensor and pump loop -------------------------
void readSensor(uint32_t now) {
  if ((uint32_t)(now - lastSensorReadAt) < SENSOR_INTERVAL_MS) {
    return;
  }
  lastSensorReadAt = now;

#if DEMO_MODE
  const float seconds = now / 1000.0f;
  temperatureC = 27.0f + 0.4f * sinf(seconds / 25.0f);
  humidityRH = 78.0f + 2.0f * sinf(seconds / 19.0f);
  sensorOK = true;
#else
  if (!sensorReady) {
    if (lastSensorAttemptAt != 0 &&
        (uint32_t)(now - lastSensorAttemptAt) < SENSOR_RETRY_MS) {
      return;
    }
    lastSensorAttemptAt = now;
    sensorReady = sht30.begin(0x44) || sht30.begin(0x45);
    if (!sensorReady) {
      sensorOK = false;
      Serial.println("[SHT30] Tidak terdeteksi; akan dicoba kembali.");
      return;
    }
    Serial.println("[SHT30] Terhubung.");
  }

  const float newTemperature = sht30.readTemperature();
  const float newHumidity = sht30.readHumidity();
  if (!isnan(newTemperature) && !isnan(newHumidity) &&
      newHumidity >= 0 && newHumidity <= 100) {
    temperatureC = newTemperature;
    humidityRH = newHumidity;
    sensorOK = true;
  } else {
    sensorOK = false;
    sensorReady = false;
    Serial.println("[SHT30] Pembacaan gagal; siram otomatis dijeda.");
  }
#endif
}

void servicePump(uint32_t now) {
  if (otaUpdateInProgress) {
    return;
  }

  if (pumpRunning) {
    const uint32_t elapsed = (uint32_t)(now - pumpStartedAt);
    if (elapsed >= pumpRunDurationMs() || elapsed >= HARD_PUMP_LIMIT_MS) {
      stopWatering("batas durasi tercapai");
    }
    return;
  }

  const uint32_t scheduleAnchor = lastWateringAt != 0
                                      ? lastWateringAt
                                      : scheduleStartedAt;
  if (autoEnabled &&
      (uint32_t)(now - scheduleAnchor) >= wateringIntervalMs()) {
#if DEMO_MODE
    startWatering("Jadwal demo", false);
#else
    const bool gapPassed = lastWateringAt == 0 ||
                           (uint32_t)(now - lastWateringAt) >= MIN_WATERING_GAP_MS;
    if (sensorOK && gapPassed &&
        wateringsInLast24Hours(now) < maxWateringsPerDay()) {
      startWatering("Jadwal otomatis", false);
    }
#endif
  }
}

// ------------------------- Firebase callbacks -------------------------
void onFirebaseResult(AsyncResult &result) {
  if (!result.isResult()) {
    return;
  }

  if (result.uid() == "safePumpReset") {
    if (result.isError()) {
      safePumpResetPending = false;
    } else if (result.available()) {
      safePumpResetPending = false;
      safePumpResetComplete = true;
    }
  }

  if (result.isError()) {
    Firebase.printf("[Firebase] %s: %s (%d)\n", result.uid().c_str(),
                    result.error().message().c_str(), result.error().code());
  }
}

void reportFirebaseQueuePressure(uint32_t now, const char *operation) {
  if ((uint32_t)(now - lastQueueWarningAt) < 15000UL) {
    return;
  }
  lastQueueWarningAt = now;
  Serial.printf("[Firebase] Antrean padat (%u tugas); %s ditunda. Heap bebas: %u byte.\n",
                (unsigned)firebaseClient.taskCount(), operation,
                (unsigned)ESP.getFreeHeap());
}

void onControlResult(AsyncResult &result) {
  if (!result.isResult()) {
    return;
  }
  if (result.isError()) {
    controlPollPending = false;
    Firebase.printf("[Firebase control] %s (%d)\n",
                    result.error().message().c_str(), result.error().code());
    return;
  }
  if (!result.available()) {
    return;
  }

  controlPollPending = false;
  const String payload = result.c_str();
  if (payload == "null" || payload.length() == 0) {
    return;
  }

  FirebaseJson controlJson;
  FirebaseJsonData value;
  if (!controlJson.setJsonData(payload)) {
    Serial.println("[Firebase] Data kontrol tidak valid.");
    return;
  }

  String remoteMode = "auto";
  bool requestedPump = false;
  bool requestedAutoPaused = true;
  if (controlJson.get(value, "mode") && value.success) {
    remoteMode = value.to<String>();
  }
  if (controlJson.get(value, "pump") && value.success) {
    requestedPump = value.to<bool>();
  }
  if (controlJson.get(value, "autoPaused") && value.success) {
    requestedAutoPaused = value.to<bool>();
  }
  applyRemoteControl(remoteMode, requestedPump, requestedAutoPaused);
}

// ------------------------- Firebase tasks -------------------------
void startFirebaseWhenReady() {
  if (firebaseStarted || WiFi.status() != WL_CONNECTED || nowEpochMs() == 0) {
    return;
  }

  initializeApp(firebaseClient, firebaseApp, getAuth(userAuth),
                onFirebaseResult, "authTask");
  firebaseApp.getApp<RealtimeDatabase>(Database);
  Database.url(FIREBASE_DATABASE_URL);
  firebaseStarted = true;
  Serial.println("[Firebase] Autentikasi dimulai.");
}

void pollControl(uint32_t now) {
  if (controlPollPending ||
      (uint32_t)(now - lastControlPollAt) < CONTROL_POLL_MS) {
    return;
  }
  if (firebaseClient.taskCount() >= FIREBASE_CONTROL_QUEUE_LIMIT) {
    reportFirebaseQueuePressure(now, "poll kontrol");
    return;
  }
  lastControlPollAt = now;
  controlPollPending = true;
  Database.get(firebaseClient, CONTROL_PATH, onControlResult, false,
               "controlPoll");
}

void publishTelemetry(uint32_t now) {
  if (!sensorOK ||
      (uint32_t)(now - lastTelemetryAt) < TELEMETRY_INTERVAL_MS) {
    return;
  }
  lastTelemetryAt = now;

  if (firebaseClient.taskCount() >= FIREBASE_BACKGROUND_QUEUE_LIMIT) {
    reportFirebaseQueuePressure(now, "telemetry/riwayat");
    return;
  }

  const uint64_t timestamp = nowEpochMs();
  char json[180];
  snprintf(json, sizeof(json),
           "{\"temperature\":%.2f,\"humidity\":%.2f,\"timestamp\":%llu}",
           temperatureC, humidityRH, (unsigned long long)timestamp);
  Database.set<object_t>(firebaseClient, TELEMETRY_PATH, object_t(json),
                         onFirebaseResult, "telemetryWrite");

  if (timestamp > 0 &&
      (uint32_t)(now - lastHistoryAt) >= HISTORY_INTERVAL_MS) {
    if (firebaseClient.taskCount() >= FIREBASE_BACKGROUND_QUEUE_LIMIT) {
      return;
    }
    lastHistoryAt = now;
    char historyJson[220];
    snprintf(historyJson, sizeof(historyJson),
             "{\"temperature\":%.2f,\"humidity\":%.2f,\"pump\":%s,\"timestamp\":%llu}",
             temperatureC, humidityRH, pumpRunning ? "true" : "false",
             (unsigned long long)timestamp);
    Database.push<object_t>(firebaseClient, HISTORY_PATH, object_t(historyJson),
                            onFirebaseResult, "historyWrite");
  }
}

void publishDeviceStatus(uint32_t now) {
  if ((uint32_t)(now - lastStatusAt) < STATUS_INTERVAL_MS) {
    return;
  }
  // Heartbeat has higher priority than telemetry/history, but still leave
  // room for Firebase's auth and control tasks.
  if (firebaseClient.taskCount() >= FIREBASE_CONTROL_QUEUE_LIMIT) {
    reportFirebaseQueuePressure(now, "heartbeat");
    return;
  }
  lastStatusAt = now;

  const String ip = WiFi.localIP().toString();
  const String mac = WiFi.macAddress();
  char json[240];
  snprintf(json, sizeof(json),
           "{\"online\":true,\"lastSeen\":%llu,\"ip\":\"%s\",\"mac\":\"%s\",\"firmwareVersion\":\"%s\",\"uptimeSeconds\":%lu}",
           (unsigned long long)nowEpochMs(), ip.c_str(), mac.c_str(),
           FIRMWARE_VERSION, (unsigned long)(millis() / 1000UL));
  Database.set<object_t>(firebaseClient, STATUS_PATH, object_t(json),
                         onFirebaseResult, "statusWrite");
}

void addOtaCorsHeaders() {
  otaServer.sendHeader("Access-Control-Allow-Origin", "*");
  otaServer.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  otaServer.sendHeader("Access-Control-Allow-Headers", "Content-Type, X-OTA-Password");
  otaServer.sendHeader("Access-Control-Allow-Private-Network", "true");
  otaServer.sendHeader("Cache-Control", "no-store");
}

void handleOtaPreflight() {
  addOtaCorsHeaders();
  otaServer.send(204);
}

void handleOtaInfo() {
  addOtaCorsHeaders();
  const String ip = WiFi.localIP().toString();
  const String mac = WiFi.macAddress();
  String json = "{\"deviceName\":\"esp32-01\",\"ip\":\"" + ip +
                "\",\"mac\":\"" + mac + "\",\"firmwareVersion\":\"" +
                FIRMWARE_VERSION + "\",\"uptimeSeconds\":" +
                String(millis() / 1000UL) + ",\"freeSketchSpace\":" +
                String(ESP.getFreeSketchSpace()) + "}";
  otaServer.send(200, "application/json", json);
}

void handleOtaUploadChunk() {
  HTTPUpload &upload = otaServer.upload();

  if (upload.status == UPLOAD_FILE_START) {
    otaUploadAuthorized = otaServer.header("X-OTA-Password") == String(OTA_PASSWORD);
    otaUploadFinished = false;
    otaUploadError = "";

    if (String(OTA_PASSWORD) == "GANTI_PASSWORD_OTA_UNIK") {
      otaUploadError = "password-not-configured";
      return;
    }
    if (!otaUploadAuthorized) {
      otaUploadError = "unauthorized";
      return;
    }
    if (pumpRunning) {
      otaUploadError = "pump-running";
      return;
    }

    otaUpdateInProgress = true;
    if (!Update.begin(UPDATE_SIZE_UNKNOWN, U_FLASH)) {
      otaUploadError = "begin-failed";
      otaUpdateInProgress = false;
    }
  } else if (upload.status == UPLOAD_FILE_WRITE) {
    if (otaUploadError.length() == 0 && otaUploadAuthorized) {
      if (Update.write(upload.buf, upload.currentSize) != upload.currentSize) {
        otaUploadError = "write-failed";
        Update.abort();
        otaUpdateInProgress = false;
      }
    }
  } else if (upload.status == UPLOAD_FILE_END) {
    if (otaUploadError.length() == 0 && otaUploadAuthorized) {
      if (Update.end(true)) {
        otaUploadFinished = true;
      } else {
        otaUploadError = "validation-failed";
        otaUpdateInProgress = false;
      }
    }
  } else if (upload.status == UPLOAD_FILE_ABORTED) {
    Update.abort();
    otaUploadError = "upload-aborted";
    otaUpdateInProgress = false;
  }
}

void handleOtaUploadComplete() {
  addOtaCorsHeaders();
  if (String(OTA_PASSWORD) == "GANTI_PASSWORD_OTA_UNIK") {
    otaServer.send(503, "application/json", "{\"error\":\"password-not-configured\"}");
    return;
  }
  if (otaUploadError == "unauthorized") {
    otaServer.send(401, "application/json", "{\"error\":\"unauthorized\"}");
    return;
  }
  if (otaUploadError == "pump-running") {
    otaServer.send(409, "application/json", "{\"error\":\"pump-running\"}");
    return;
  }
  if (!otaUploadFinished) {
    const String error = otaUploadError.length() ? otaUploadError : "upload-failed";
    otaUpdateInProgress = false;
    otaServer.send(400, "application/json", "{\"error\":\"" + error + "\"}");
    return;
  }

  otaServer.send(200, "application/json", "{\"ok\":true,\"rebooting\":true}");
  delay(700);
  ESP.restart();
}

void setupOtaServer() {
  const char *headers[] = {"X-OTA-Password"};
  otaServer.collectHeaders(headers, 1);
  otaServer.on("/ota/info", HTTP_OPTIONS, handleOtaPreflight);
  otaServer.on("/ota/update", HTTP_OPTIONS, handleOtaPreflight);
  otaServer.on("/ota/info", HTTP_GET, handleOtaInfo);
  otaServer.on("/ota/update", HTTP_POST, handleOtaUploadComplete,
                handleOtaUploadChunk);
  otaServer.onNotFound([]() {
    addOtaCorsHeaders();
    otaServer.send(404, "application/json", "{\"error\":\"not-found\"}");
  });
  otaServer.begin();
  Serial.println("[OTA] Server lokal aktif pada port 80.");
}

void clearOldPumpCommand() {
  if (safePumpResetComplete || safePumpResetPending) {
    return;
  }
  safePumpResetPending = true;
  Database.set<bool>(firebaseClient, CONTROL_PATH + "/pump", false,
                     onFirebaseResult, "safePumpReset");
}

// ------------------------- Wi-Fi and serial -------------------------
void serviceWiFi(uint32_t now) {
  static bool wasConnected = false;
  const wl_status_t status = WiFi.status();
  const bool connected = status == WL_CONNECTED;

  if (connected && !wasConnected) {
    Serial.print("[Wi-Fi] Terhubung, IP: ");
    Serial.println(WiFi.localIP());
    if (!timeSyncStarted) {
      configTime(7 * 60 * 60, 0, "pool.ntp.org", "time.google.com");
      timeSyncStarted = true;
    }
  } else if (!connected && wasConnected) {
    Serial.println("[Wi-Fi] Terputus.");
  }
  wasConnected = connected;

  const bool canRetry = status == WL_DISCONNECTED ||
                        status == WL_CONNECT_FAILED ||
                        status == WL_NO_SSID_AVAIL ||
                        status == WL_CONNECTION_LOST;
  if (connected || !canRetry ||
      (uint32_t)(now - lastWiFiAttemptAt) < WIFI_RETRY_MS) {
    return;
  }

  lastWiFiAttemptAt = now;
  Serial.println("[Wi-Fi] Mencoba koneksi ulang...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void serviceSerial() {
  while (Serial.available()) {
    const char input = (char)Serial.read();
    if (input == 'm' || input == 'M') {
      startWatering("Perintah serial", true);
    } else if (input == 'a' || input == 'A') {
      autoEnabled = !autoEnabled;
      if (firebaseApp.ready()) {
        Database.set<String>(firebaseClient, CONTROL_PATH + "/mode",
                             autoEnabled ? "auto" : "manual",
                             onFirebaseResult, "modeWrite");
      }
    } else if (input == 's' || input == 'S') {
      Serial.printf("[STATUS] %s | Suhu %.1f C | RH %.1f %%\n",
                    pumpRunning ? "MENYIRAM" : "SIAGA",
                    temperatureC, humidityRH);
    }
  }
}

// ------------------------- Arduino entry points -------------------------
void setup() {
  digitalWrite(PUMP_PIN, LOW);
  pinMode(PUMP_PIN, OUTPUT);
  digitalWrite(PUMP_PIN, LOW);

#if !DEMO_MODE
  pumpPwmReady = ledcAttach(PUMP_PIN, PUMP_PWM_FREQUENCY_HZ,
                            PUMP_PWM_RESOLUTION_BITS);
  if (pumpPwmReady) {
    pumpPwmReady = ledcWrite(PUMP_PIN, 0);
  }
  if (!pumpPwmReady) {
    ledcDetach(PUMP_PIN);
    pinMode(PUMP_PIN, OUTPUT);
    digitalWrite(PUMP_PIN, LOW);
    Serial.println("[POMPA] Inisialisasi PWM gagal; output dipaksa LOW.");
  }
#endif

  Serial.begin(115200);
  delay(250);
  scheduleStartedAt = millis();

  Serial.println("\n=== TAUGE IoT — FIREBASE ===");
  Serial.printf("Mode: %s\n", DEMO_MODE ? "DEMO (pompa fisik mati)"
                                         : "HARDWARE NYATA");
  Serial.println("Serial: m=siram, a=ganti otomatis/manual, s=status");

#if !DEMO_MODE
  Wire.begin(SHT30_SDA_PIN, SHT30_SCL_PIN);
#endif

  sslClient.setCACert(GOOGLE_GTS_ROOT_R1);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  Serial.println("[Wi-Fi] Menghubungkan ke jaringan 2.4 GHz...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWiFiAttemptAt = millis();
  setupOtaServer();
}

void loop() {
  const uint32_t now = millis();

  otaServer.handleClient();
  serviceSerial();
  readSensor(now);
  servicePump(now);  // Local pump timer remains responsive during network work.
  serviceWiFi(now);
  startFirebaseWhenReady();

  if (firebaseStarted) {
    firebaseApp.loop();
  }
  if (firebaseStarted && firebaseApp.ready()) {
    clearOldPumpCommand();
    if (safePumpResetComplete) {
      pollControl(now);
      publishTelemetry(now);
      publishDeviceStatus(now);
    }
  }

  delay(5);
}
