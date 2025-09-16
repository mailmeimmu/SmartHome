# Smart Home Backend (MySQL)

Express + MySQL service that powers the Expo app: face/PIN auth, member policies, door control, and real-time sensor ingestion for household devices.

## Requirements
- Node.js 18+
- MySQL 8 with credentials (host, user, password)

## Setup & Deployment
1. **Copy environment file**
   ```bash
   cd server
   cp .env.example .env
   # edit .env with MySQL credentials, PORT, SENSOR_SHARED_SECRET (optional)
   ```
2. **Install dependencies & create tables**
   ```bash
   npm install
   node scripts/migrate.js
   ```
3. **Run locally**
   ```bash
   npm start
   ```
4. **Production tips**
   - Keep `.env` on the server with MySQL settings and optional device secret.
   - Use pm2 or systemd to run `node src/app.js` as a service.
   - Expose the configured port (default `8080`).

## API Overview
All endpoints live under the server base URL (e.g. `http://YOUR_SERVER:8080`). JSON payloads are required. When `SENSOR_SHARED_SECRET` is set, hardware must include `x-device-secret` header with the matching value.

### Authentication & Members
- `POST /api/register` – register user with face template { name, email?, template, faceId? }.
- `POST /api/auth/face` – authenticate via face template.
- `POST /api/auth/pin` – authenticate via PIN.
- `GET /api/users` – list members with policies.
- `POST /api/members` – add family member without biometric enrollment.
- `PATCH /api/members/:id` – update member profile or policy JSON.
- `DELETE /api/members/:id` – delete a member.

### Door Control
- `GET /api/door` – returns door lock states `{ "main": true, ... }` (`true` = locked).
- `POST /api/door/toggle` – toggle a door lock `{ "door": "front" }`.
- `POST /api/door/lock_all` – lock every door.
- `POST /api/door/unlock_all` – unlock every door.

### Sensor Readings (Lights, Fans, AC, etc.)
Use one logical `deviceId` per physical device and send metrics (state, power usage, temperature, etc.). Suggested IDs for the 12 devices the engineer team manages:

| Area / Device         | `deviceId`            | Notes |
| --------------------- | --------------------- | ----- |
| Main Hall Light A     | `mainhall-light-1`    | `power` (0/1) |
| Main Hall Light B     | `mainhall-light-2`    | `power` (0/1) |
| Main Hall Fan         | `mainhall-fan-1`      | `power` (0/1) |
| Main Hall AC          | `mainhall-ac-1`       | `power` (0/1) |
| Bedroom 1 Light       | `bedroom1-light-1`    | `power` (0/1) |
| Bedroom 1 Fan         | `bedroom1-fan-1`      | `power` (0/1) |
| Bedroom 1 AC          | `bedroom1-ac-1`       | `power` (0/1) |
| Bedroom 2 Light       | `bedroom2-light-1`    | `power` (0/1) |
| Bedroom 2 Fan         | `bedroom2-fan-1`      | `power` (0/1) |
| Bedroom 2 AC          | `bedroom2-ac-1`       | `power` (0/1) |
| Kitchen Light         | `kitchen-light-1`     | `power` (0/1) |

Sample payloads for each device type (replace `deviceId` and values as needed). All of these can also be sent through the simplified `/api/devices/:deviceId/state` endpoint using just `value` for on/off signals.

- Main Hall - Light A
  ```json
  {
    "deviceId": "mainhall-light-1",
    "metric": "power",
    "value": 1,
    "unit": "state",
    "metadata": { "source": "esp32-light-1" }
  }
  ```

- Bedroom 1 - Light
  ```json
  {
    "deviceId": "bedroom1-light-1",
    "metric": "watt",
    "value": 18.4,
    "unit": "W",
    "metadata": { "sampleInterval": "5s" }
  }
  ```

- Bedroom 2 - Fan
  ```json
  {
    "deviceId": "bedroom2-fan-1",
    "metric": "speed",
    "value": 4,
    "unit": "level",
    "metadata": { "controller": "panel" }
  }
  ```

- Main Hall - Fan
  ```json
  {
    "deviceId": "mainhall-fan-1",
    "metric": "power",
    "value": 0,
    "unit": "state",
    "metadata": { "reason": "schedule" }
  }
  ```

- Bedroom 1 - AC temperature reading
  ```json
  {
    "deviceId": "bedroom1-ac-1",
    "metric": "temperature",
    "value": 22.5,
    "unit": "C",
    "metadata": { "sensor": "internal" }
  }
  ```

- Bedroom 2 - AC operating mode change (use numeric codes that map to your firmware)
  ```json
  {
    "deviceId": "bedroom2-ac-1",
    "metric": "mode",
    "value": 2,
    "unit": "enum",
    "metadata": { "mapping": { "0": "off", "1": "cool", "2": "heat" } }
  }
  ```

- Main Hall - AC power snapshot
  ```json
  {
    "deviceId": "mainhall-ac-1",
    "metric": "power",
    "value": 1450,
    "unit": "W",
    "metadata": { "compressor": "on" }
  }
  ```

#### Simplified on/off API (recommended for switches)
`POST /api/devices/:deviceId/state`

Body (no headers beyond JSON required):
```json
{ "value": 1 }
```
`value` accepts `0` (off) or `1` (on). The backend stores the reading using the default `power` metric. Optional `recordedAt` can be supplied for timestamps. Pair with:

`GET /api/devices/:deviceId/state`

Response:
```json
{ "deviceId": "mainhall-light-1", "value": 1 }
```

- `GET /api/devices/state` – fetch the latest on/off state for every device.
- `GET /api/devices/state?ids=mainhall-light-1,bedroom1-fan-1` – limit the response to selected device IDs.

#### Ingest data from hardware (full sensor endpoint)
`POST /api/sensors/:deviceId/readings`

Headers:
- `Content-Type: application/json`
- `x-device-secret: YOUR_SECRET` *(only if configured)*

Body example:
```json
{
  "metric": "power",
  "value": 1,
  "unit": "state",
  "recordedAt": "2024-05-23T12:45:00Z",
  "metadata": { "source": "esp32", "notes": "Light turned on" }
}
```
- `value` must be numeric (send booleans as 0/1).
- `recordedAt` is optional; defaults to server time.
- `metadata` is free-form JSON (stored as JSON column).
- Response returns the stored reading with canonical timestamp.

#### Fetch historical readings
`GET /api/sensors/:deviceId/readings?metric=power&limit=50&since=2024-05-20`

Query parameters:
- `metric` (optional) – filter by a single metric.
- `limit` (default 50, max 500).
- `since` / `until` (ISO 8601 strings) – time window.

Response snippet:
```json
{
  "deviceId": "mainhall-light-1",
  "metric": "power",
  "count": 3,
  "readings": [
    { "id": 12, "metric": "power", "value": 1, "unit": "state", "recordedAt": "2024-05-23T12:45:00.000Z" }
  ]
}
```

#### Fetch latest readings
- `GET /api/sensors/:deviceId/readings/latest` – latest reading per metric.
- `GET /api/sensors/:deviceId/readings/latest?metric=temperature` – latest reading for one metric.

## Database Schema
`scripts/schema.sql` contains the full DDL. Tables of interest:
- `users`
- `face_templates`
- `door_state`
- `user_policies`
- `sensor_readings`

## Implementation Notes
- Face templates are stored as JSON strings; matching uses vector distance (< 0.12) or hash equality.
- Sensor metadata column is JSON; encode binary payloads before sending.
- Keep MySQL credentials and shared secrets off the client; only the backend touches the database directly.
