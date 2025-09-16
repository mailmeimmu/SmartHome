# Smart Home Backend (MySQL)

This lightweight Express service adds a real MySQL backend for registration and face authentication.

## Requirements
- MySQL 8 (host, user, password)
- Node 18+

## Configure

1) Copy env

```
cd server
cp .env.example .env
# edit .env with your credentials
```

2) Create DB + tables

```
npm install
npm run migrate
```

3) Start API

```
npm start
```

## Endpoints

- POST `/api/register` { name, email?, template, faceId? }
  - Saves user and face template. Prevents duplicate face.
- POST `/api/auth/face` { template }
  - Matches template against saved users.
- POST `/api/auth/pin` { pin }
  - PIN login.
- GET `/api/users`
  - List users.

## Schema
See `scripts/schema.sql` for full DDL. Main tables:
- `users`
- `face_templates`
- `door_state` (optional)
- `user_policies` (optional)

## Notes
- Template is stored as JSON string (landmark vector or hash fallback). Matching uses vector distance (< 0.12) or hash equality.
- Never put DB credentials in the mobile app. Keep them on the server.

