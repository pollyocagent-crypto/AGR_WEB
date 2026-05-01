# Device-Relay WebSocket Protocol

Reference for Firmware Engineer implementing the ESP32 WSS client.

## Endpoints

| Endpoint                                                      | Method    | Description                        |
| ------------------------------------------------------------- | --------- | ---------------------------------- |
| `wss://<project>.supabase.co/functions/v1/device-relay`       | WebSocket | Persistent bidirectional channel   |
| `https://<project>.supabase.co/functions/v1/device-bootstrap` | POST      | One-time registration (first boot) |

---

## Bootstrap (first boot)

Call **once** at first power-on. Safe to repeat after OTA — idempotent on `device_uid`.

### Request

```
POST /functions/v1/device-bootstrap
Content-Type: application/json

{ "device_uid": "<factory-burned UID from NVS>" }
```

No Authorization header required.

### Response `200 OK`

```json
{
  "device_id": "550e8400-e29b-41d4-a716-446655440000",
  "jwt": "<device-jwt — store in NVS>",
  "pairing_code": "483920"
}
```

- **`device_id`** — Persist in NVS. Used in QR code for pairing.
- **`jwt`** — Persist in NVS. Used as `Authorization: Bearer` for every WSS connection. Valid 365 days; re-bootstrap before expiry or after factory reset.
- **`pairing_code`** — Display on HMI QR screen. 6 digits. TTL 1 hour. User scans QR containing `device_id + pairing_code` to claim ownership.

---

## WebSocket Connection

### Upgrade headers

```
GET /functions/v1/device-relay HTTP/1.1
Host: <project>.supabase.co
Upgrade: websocket
Connection: Upgrade
Authorization: Bearer <device-jwt>
Sec-WebSocket-Version: 13
Sec-WebSocket-Key: <random-base64>
```

### Connection lifecycle

1. Server validates JWT → extracts `device_id`.
2. Server checks `devices.id` exists.
3. If valid: `101 Switching Protocols`.
4. If invalid: `401 Unauthorized` (bad/expired JWT) or `403 Forbidden` (device not registered).
5. On open: server drains any pending commands and starts Realtime subscription.

---

## Messages: Device → Cloud

All messages are UTF-8 JSON text frames.

### State update

Send current system state. Server does `UPSERT` into `device_state`.

```json
{
  "type": "state",
  "state": {
    "modules": [
      { "id": 1, "relay": [false, false, false, false, false, false, false, false], "online": true }
    ],
    "pump": false,
    "battery_mv": 3820,
    "program_running": false
  },
  "ts": 1746115200
}
```

- `ts` — Unix epoch (seconds) from device RTC. Optional but recommended.
- `state` — Arbitrary JSON; schema is up to the application layer.

### Command acknowledgement

Send after receiving and executing a command.

```json
{
  "type": "ack",
  "command_id": "550e8400-e29b-41d4-a716-446655440001",
  "ok": true,
  "result": { "relay_state": true }
}
```

- `ok: false` → command failed; include error info in `result`.
- Server sets `device_commands.status = 'acked'`.

### Event

Log a named event.

```json
{
  "type": "event",
  "kind": "boot",
  "data": { "firmware": "1.2.3", "reset_reason": "power_on" },
  "ts": 1746115200
}
```

Common `kind` values: `boot`, `error`, `wifi_reconnect`, `ota_start`, `ota_done`.

### Heartbeat ping

Send every **30 seconds** to keep the connection alive. If the server receives no message for **90 seconds**, it closes the connection with code `4000`.

```json
{ "type": "ping" }
```

---

## Messages: Cloud → Device

### Command

Issued by web users via REST. Delivered over the open WSS connection.

```json
{
  "type": "command",
  "id": "550e8400-e29b-41d4-a716-446655440001",
  "payload": {
    "action": "set_relay",
    "module": 1,
    "channel": 3,
    "state": true
  }
}
```

- `id` — UUID. Persist this; send it back in the `ack` message.
- `payload` — Arbitrary JSON; defined by the web application.

### Heartbeat pong

Response to device `ping`.

```json
{ "type": "pong" }
```

---

## Reconnect strategy

1. On disconnect or TCP error: exponential back-off starting at 5 s, cap at 60 s.
2. Re-use the same JWT from NVS. No need to re-bootstrap unless JWT is expired or rejected with `401`.
3. After reconnect: server drains any pending commands that arrived while device was offline.

---

## QR Code format

The HMI QR code encodes:

```
agr://pair?device_id=<device_id>&code=<pairing_code>
```

The web app reads this URL on QR scan and calls the pairing endpoint with the `device_id` and `code`. The pairing_code expires after 1 hour; device can re-bootstrap to get a fresh code.

---

## Security notes

- Device JWT is signed with `SUPABASE_JWT_SECRET` (HS256). Keep NVS partition encrypted (ESP32 flash encryption).
- `device-relay` runs as service role — it bypasses RLS. All writes are scoped to the validated `device_id` from JWT.
- `device-bootstrap` has no auth. Rate-limit at the edge (Cloudflare or Supabase rate limit) to prevent abuse.
- Pairing codes are single-use and expire in 1 hour.
