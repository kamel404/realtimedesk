# Real-Time Support Desk

A full-stack customer support application built with **Next.js, NestJS, PostgreSQL, Prisma, Redis, Socket.IO, BullMQ, and Docker**.

Customers open tickets and chat with support agents in real time. The project demonstrates a clean, production-style architecture: authentication and role-based authorization, validated REST APIs, real-time communication, caching, background jobs, and containerized infrastructure.

> **Status:** actively in development. The core flow (auth → tickets → real-time chat) works end to end; see [Roadmap](#roadmap) for what's next.

---

## Stack

| Layer           | Technology                              |
| --------------- | --------------------------------------- |
| Frontend        | Next.js (App Router) + React + TypeScript + Tailwind |
| Backend         | NestJS + TypeScript                     |
| Database        | PostgreSQL                              |
| ORM             | Prisma                                  |
| Cache / Queue   | Redis                                   |
| Background Jobs | BullMQ                                  |
| Real-time       | Socket.IO (NestJS Gateway)              |
| Auth            | JWT (Passport) + bcrypt                 |
| Validation      | class-validator / class-transformer     |
| API Docs        | Swagger (`/api/docs`)                   |
| Infrastructure  | Docker Compose                          |

---

## Architecture

```text
                    Next.js (port 3000)
                          │
               REST (/api) + Socket.IO
                          │
                  NestJS API (port 4000)
            ┌─────────────┼──────────────┐
            │             │              │
        Prisma         Redis          Gateway
            │        ┌────┴────┐      (Socket.IO)
       PostgreSQL   Cache    BullMQ
                               │
                         Notification
                           Processor
```

| Component  | Responsibility                                   |
| ---------- | ------------------------------------------------ |
| Next.js    | UI, calls REST API, holds a Socket.IO connection |
| NestJS     | API, business logic, authorization, WebSockets   |
| PostgreSQL | Persistent data                                  |
| Prisma     | Type-safe database access + migrations           |
| Redis      | Ticket cache + BullMQ job storage                |
| BullMQ     | Background jobs (notifications)                  |
| Docker     | Reproducible local infrastructure                |

The BullMQ processor currently runs inside the API process. In production it would move to its own worker container so jobs scale independently of HTTP traffic.

### Request flow

```text
Request → JwtAuthGuard → RolesGuard → Controller → ValidationPipe (DTO) → Service → Prisma → PostgreSQL
```

**Rules**

- Controllers handle HTTP only.
- Services hold business logic, including ownership checks ("is this *your* ticket?").
- Guards answer "who are you?" (authentication) and "what role do you have?" (role-based authorization).
- Prisma is the only layer that talks to the database.

---

## Features

### Authentication & Authorization

- Register / login with bcrypt-hashed passwords
- JWT access tokens, `GET /api/auth/me`
- Roles: `CUSTOMER`, `AGENT`, `ADMIN`
- `@Roles()` decorator + `RolesGuard`
- Passwords are never returned in responses

### Permissions

| Action                    | CUSTOMER        | AGENT                         | ADMIN |
| ------------------------- | --------------- | ----------------------------- | ----- |
| Create ticket             | ✅              | ❌                            | ❌    |
| List / view tickets       | Own only        | Assigned + unassigned         | All   |
| Send message              | Own tickets     | Assigned tickets              | All   |
| Update status             | ❌              | Assigned tickets              | ✅    |
| Assign agent              | ❌              | Self-assign unassigned        | ✅    |
| Delete ticket             | ❌              | ❌                            | ✅    |

Role checks live in guards; ownership checks live in `TicketsService`.

### Tickets

- Create, list (paginated, filter by status), view, update status, assign agent, delete
- Statuses: `OPEN → IN_PROGRESS → RESOLVED → CLOSED`

### Real-time chat

```text
Customer ↔ NestJS Gateway ↔ Agent   (one Socket.IO room per ticket: ticket:<id>)
```

| Event          | Direction       | Purpose                                 |
| -------------- | --------------- | --------------------------------------- |
| `join_ticket`  | client → server | Join a ticket room (permission-checked) |
| `send_message` | client → server | Send a chat message                     |
| `new_message`  | server → room   | Broadcast a saved message               |
| `typing`       | both            | Typing indicator                        |

- The JWT is verified during the socket handshake; unauthenticated sockets are disconnected.
- `join_ticket` runs the same ownership check as the REST endpoint.
- **Single write path:** both `POST /api/tickets/:id/messages` and `send_message` call `TicketsService.addMessage()`, which **saves the message first, then emits** `new_message`. The database is the source of truth; the socket is only delivery.

### Caching (Redis)

- `GET /api/tickets/:id` is cached with a short TTL.
- The cache entry is invalidated on ticket update, assignment, and new message.
- Lists are not cached: they vary per user and page, which makes invalidation error-prone.

### Background jobs (BullMQ)

```text
Ticket created → add job to "notifications" queue (Redis) → NotificationsProcessor → log "Notified agents of ticket #id"
```

The ticket API responds immediately; notification work happens asynchronously with retries. Email delivery is simulated with a log for now.

---

## Project Structure

### Backend

```text
backend/
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts                 # admin, agent, customer + sample tickets
└── src/
    ├── auth/
    │   ├── auth.controller.ts
    │   ├── auth.service.ts
    │   ├── auth.module.ts
    │   ├── jwt.strategy.ts
    │   └── dto/                # register.dto.ts, login.dto.ts
    ├── users/
    │   ├── users.service.ts
    │   └── users.module.ts
    ├── tickets/
    │   ├── tickets.controller.ts
    │   ├── tickets.service.ts
    │   ├── tickets.gateway.ts
    │   ├── tickets.module.ts
    │   └── dto/                # create-ticket, update-ticket, create-message, query-tickets
    ├── notifications/
    │   ├── notifications.module.ts
    │   └── notifications.processor.ts
    ├── prisma/
    │   ├── prisma.module.ts
    │   └── prisma.service.ts
    ├── common/
    │   ├── decorators/         # roles.decorator.ts, current-user.decorator.ts
    │   ├── guards/             # jwt-auth.guard.ts, roles.guard.ts
    │   └── filters/            # prisma-exception.filter.ts
    ├── config/                 # env validation
    ├── app.module.ts
    └── main.ts                 # global prefix, ValidationPipe, CORS, Swagger
```

### Frontend

```text
frontend/src/
├── app/
│   ├── login/page.tsx
│   ├── register/page.tsx
│   ├── tickets/
│   │   ├── page.tsx            # list + filter
│   │   ├── new/page.tsx        # create (customers)
│   │   └── [id]/page.tsx       # details + live chat
│   └── layout.tsx
├── components/
│   ├── tickets/                # TicketCard, StatusBadge, ChatPanel, MessageBubble
│   └── ui/                     # Button, Input, Card
├── lib/
│   ├── api.ts                  # fetch wrapper that attaches the JWT
│   └── socket.ts               # Socket.IO client factory
├── hooks/
│   ├── useAuth.ts
│   └── useTicketSocket.ts      # join room, listen for new_message / typing
└── types/                      # user.ts, ticket.ts, message.ts
```

The dashboard is the ticket list; the profile page is out of scope for now.

---

## Database

```prisma
enum Role         { CUSTOMER AGENT ADMIN }
enum TicketStatus { OPEN IN_PROGRESS RESOLVED CLOSED }

model User {
  id        String    @id @default(uuid())
  name      String
  email     String    @unique
  password  String
  role      Role      @default(CUSTOMER)
  created   Ticket[]  @relation("CustomerTickets")
  assigned  Ticket[]  @relation("AgentTickets")
  messages  Message[]
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}

model Ticket {
  id          String       @id @default(uuid())
  subject     String
  description String
  status      TicketStatus @default(OPEN)
  customer    User         @relation("CustomerTickets", fields: [customerId], references: [id])
  customerId  String
  agent       User?        @relation("AgentTickets", fields: [agentId], references: [id])
  agentId     String?
  messages    Message[]
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt

  @@index([customerId])
  @@index([agentId])
  @@index([status])
}

model Message {
  id        String   @id @default(uuid())
  content   String
  ticket    Ticket   @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  ticketId  String
  author    User     @relation(fields: [authorId], references: [id])
  authorId  String
  createdAt DateTime @default(now())

  @@index([ticketId])
}
```

Two relations between `User` and `Ticket` (customer and agent) need named relations. Indexes cover the most common filters.

---

## REST API

All routes are prefixed with `/api`.

```http
POST   /api/auth/register
POST   /api/auth/login
GET    /api/auth/me

GET    /api/tickets?status=OPEN&page=1&limit=20
POST   /api/tickets
GET    /api/tickets/:id
PATCH  /api/tickets/:id            # status, agentId
DELETE /api/tickets/:id            # admin only

GET    /api/tickets/:id/messages
POST   /api/tickets/:id/messages
```

Swagger: **http://localhost:4000/api/docs**

---

## Getting Started

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
docker compose up --build
docker compose exec backend npx prisma migrate deploy
docker compose exec backend npx prisma db seed
```

| Service  | URL                            |
| -------- | ------------------------------ |
| Frontend | http://localhost:3000          |
| API      | http://localhost:4000/api      |
| Swagger  | http://localhost:4000/api/docs |

**Seeded accounts** (password `password123`):

| Role     | Email                |
| -------- | -------------------- |
| Admin    | admin@desk.dev       |
| Agent    | agent@desk.dev       |
| Customer | customer@desk.dev    |

### Environment

`backend/.env`

```env
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/support_desk
REDIS_HOST=redis
REDIS_PORT=6379
JWT_SECRET=change-me
JWT_EXPIRES_IN=1d
PORT=4000
FRONTEND_URL=http://localhost:3000
```

`frontend/.env.local`

```env
NEXT_PUBLIC_API_URL=http://localhost:4000/api
NEXT_PUBLIC_WS_URL=http://localhost:4000
```

The frontend URLs use `localhost`, not the Docker service name, because they're called from the browser, which runs outside the Docker network. Never commit real secrets; only `.env.example` is tracked.

---

## One-Day Build Plan

Each block ends in something that **works and can be demoed**. If a block runs over, cut from the bottom, never from the middle.

### Morning: backend core (must have)

| Time        | Block                     | Done when                                                                              |
| ----------- | ------------------------- | -------------------------------------------------------------------------------------- |
| 08:00–09:00 | Setup                     | Nest + Next scaffolded, Compose runs Postgres and Redis, Prisma migrated, seed works   |
| 09:00–11:00 | Auth                      | Register/login/me work in Swagger; `JwtAuthGuard`, `RolesGuard`, `@Roles()`, `@CurrentUser()` |
| 11:00–13:00 | Tickets CRUD              | All endpoints with DTO validation, ownership checks, pagination, Swagger decorators   |

### Afternoon: real-time + frontend (must have)

| Time        | Block                     | Done when                                                                              |
| ----------- | ------------------------- | -------------------------------------------------------------------------------------- |
| 13:30–15:00 | Gateway                   | JWT on handshake, `join_ticket`, `send_message` → `addMessage()` → `new_message`       |
| 15:00–16:00 | Frontend auth             | Login page stores the token; `api.ts` attaches it; protected redirect                  |
| 16:00–17:30 | Frontend tickets          | List with status badges, create form, detail page                                      |
| 17:30–19:00 | Frontend chat             | `useTicketSocket` joins the room; messages appear live in two browser windows          |

### Evening: depth (nice to have, in this order)

| Time        | Block                     | Done when                                                                              |
| ----------- | ------------------------- | -------------------------------------------------------------------------------------- |
| 19:30–20:15 | BullMQ                    | Ticket creation enqueues a job; processor logs the notification                        |
| 20:15–21:00 | Redis cache               | `GET /tickets/:id` cached; invalidated on update and new message                       |
| 21:00–21:30 | Polish                    | Typing indicator, exception filter, README updated with what works                     |
| 21:30–23:00 | **Interview prep**        | Rehearse the demo and talking points below. Don't skip this for features.              |

### Cut list (if behind schedule)

1. Typing indicator
2. Redis cache: explain the strategy instead of building it
3. Register page: use seeded accounts
4. BullMQ: keep only the queue + log, no retries config

**Never cut:** auth guards, the ownership check, the gateway's JWT check, and the live chat demo. Those are the strongest parts of the story.

### Demo script (3 minutes)

1. Swagger: log in as customer, show a `401` without a token and a `403` on an admin-only route.
2. Frontend: customer creates a ticket; backend logs show the BullMQ job.
3. Second window: agent logs in, opens the ticket, sets status to `IN_PROGRESS`.
4. Chat live between the two windows; refresh and show the messages persisted.

---

## Interview Talking Points

| Topic                          | One-line answer to build on |
| ------------------------------ | --------------------------- |
| Why NestJS over Express        | Express is unopinionated; Nest adds structure (modules, DI, decorators) that keeps a growing codebase consistent and testable. It runs on Express underneath. |
| Dependency Injection           | Classes declare what they need in the constructor; Nest's container creates and provides instances, so services are swappable and easy to mock in tests. |
| Modules / Controllers / Services | Modules group a feature, controllers map HTTP to methods, services hold the logic. |
| DTOs and validation            | DTOs define the request shape; the global `ValidationPipe` rejects bad input before it reaches the service (`whitelist` strips unknown fields). |
| Guards and JWT                 | `JwtAuthGuard` verifies the token and attaches the user; `RolesGuard` reads `@Roles()` metadata and compares it to `user.role`. |
| Authentication vs authorization | Authentication = who you are (JWT). Authorization = what you may do (roles in guards, ownership in services). |
| Why ownership lives in the service | Guards don't load the ticket; the service already does, so it checks `customerId`/`agentId` there and throws `ForbiddenException`. |
| PostgreSQL relationships       | One-to-many User→Ticket twice (customer, agent) via named relations; Ticket→Message with cascade delete. |
| Prisma                         | Schema-first, generated type-safe client, migrations tracked in git. |
| Why Redis                      | In-memory and fast: a cache for hot reads and the storage BullMQ needs for its queues. |
| Cache invalidation             | Cache single tickets only; delete the key on every write that changes them. Lists aren't cached because per-user, per-page keys are hard to invalidate correctly. |
| Why WebSockets                 | Chat needs server push. Polling wastes requests and adds latency; a socket keeps one open connection. |
| REST vs WebSockets             | REST for request/response and anything cacheable; WebSockets for live events. Here, both write paths share one service method. |
| Why save before emit           | If the emit fails, the message still exists; if the save fails, nobody sees a message that was never stored. |
| Why BullMQ                     | Slow or failure-prone work (emails) shouldn't block the HTTP response; queues add retries and isolation. |
| How services communicate       | In-process via DI; asynchronously via the queue; to clients via the gateway. |
| Why Docker                     | One command reproduces the same Postgres/Redis/app setup on any machine. |
| Scaling the gateway            | With multiple API instances, add the Socket.IO Redis adapter so rooms work across instances. |

---

## Roadmap

- [ ] Unit tests for `TicketsService` permissions, e2e tests for auth
- [ ] Separate worker container for BullMQ
- [ ] Socket.IO Redis adapter for horizontal scaling
- [ ] Real email notifications
- [ ] Refresh tokens
- [ ] Rate limiting on auth routes
- [ ] File attachments on messages

## Out of Scope

GraphQL, microservices, Kafka/RabbitMQ, tRPC, Kubernetes, CI/CD, payments. The goal is **good architecture and understanding**, not maximum technology count.
