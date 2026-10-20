# Build Phases (1–2 days)

The goal is to **understand NestJS and how it connects to PostgreSQL, Redis, WebSockets and Docker**, not to build the biggest app.

Rules for staying simple:

- Finish one phase before starting the next. Each phase ends with something you can test.
- Backend first. The frontend is last and kept small.
- If you fall behind, check the **Cut list** at the bottom instead of rushing.
- After each phase, explain its "Key idea" out loud in your own words. If you can't, re-read the code before moving on.

---

## The big picture

```text
Browser (Next.js) ──REST──►  NestJS API  ──► Prisma ──► PostgreSQL   (saved data)
        ▲                        │
        └──── Socket.IO ◄────────┤                                   (live chat)
                                 ├──► Redis (cache)                  (fast reads)
                                 └──► Redis (BullMQ queue) ──► Worker (background jobs)

Docker Compose runs PostgreSQL, Redis and, at the end, the API too.
```

Every request follows the same path:

```text
Request → Guard (who are you? what role?) → Controller (HTTP only) → DTO check → Service (logic) → Prisma → DB
```

---

## Day 1: NestJS core

### Phase 0: Setup and NestJS basics (~1h)

**Steps**

1. Move the starter app into `backend/` (everything except `.git`, the spec, and this file).
2. Remove `@nestjs/observe` from `app.module.ts` and `main.ts`, then uninstall it.
3. In `main.ts`, use port `4000`, add the `/api` prefix (`app.setGlobalPrefix('api')`) and enable CORS.
4. Install `@nestjs/config`, load `.env` with `ConfigModule.forRoot({ isGlobal: true })`.
5. Create `backend/.env` and `backend/.env.example` (values are in the spec).

**Key idea**: A NestJS app is a set of **modules**. Each module has **controllers** (handle HTTP) and **providers/services** (logic). Nest creates the services and gives them to whoever asks for them in their constructor. That's **dependency injection**.

**Done when**

- [x] `npm run start:dev` in `backend/` runs, and `http://localhost:4000/api` returns "Hello World!"

---

### Phase 1: Docker for Postgres and Redis (~30m)

**Steps**

1. Create `docker-compose.yml` at the repo root with two services: `postgres` (image `postgres:16`) and `redis` (image `redis:7`).
2. Map ports `5432` and `6379` to your machine and add a volume so Postgres keeps its data.
3. Run `docker compose up -d`, then `docker compose ps`.

**Key idea**: An **image** is a template; a **container** is a running copy of it. **Ports** let your machine reach the container. A **volume** keeps data when the container is deleted. Containers talk to each other by **service name** (`postgres`, `redis`).

> While the API runs on your machine (not in Docker), it uses `localhost` to reach the databases. In Phase 8 it switches to `postgres` / `redis`.

**Done when**

- [ ] Both containers are "running"
- [ ] `docker compose exec redis redis-cli ping` replies `PONG`

---

### Phase 2: Prisma and the database (~1h)

**Steps**

1. Install Prisma, run `npx prisma init`.
2. Paste the schema from the spec into `prisma/schema.prisma` (User, Ticket, Message, the two enums).
3. `npx prisma migrate dev --name init`
4. Create `PrismaService` (connects on startup) and `PrismaModule` (marked `@Global()` so every module can use it).
5. Write `prisma/seed.ts`: 3 users (admin, agent, customer, password `password123` hashed with bcrypt) and 2 tickets.

> This project uses ES modules. Follow the current Prisma docs for the client setup. If something breaks here, check that first.

**Key idea**: You describe tables in `schema.prisma`. Prisma creates the tables (**migrations**) and generates a **typed client**, so `prisma.ticket.findMany()` is checked by TypeScript.

**Done when**

- [ ] `npx prisma studio` shows the 3 seeded users and 2 tickets

---

### Phase 3: Auth: register, login, guards (~2.5h)

This is the most important NestJS phase. Take your time.

**Steps**

1. Install `@nestjs/jwt`, `@nestjs/passport`, `passport-jwt`, `bcrypt`, `class-validator`, `class-transformer`, `@nestjs/swagger`.
2. In `main.ts`, add a global `ValidationPipe({ whitelist: true, transform: true })` and Swagger at `/api/docs`.
3. `UsersModule` → `UsersService` with `findByEmail`, `findById`, `create`.
4. `AuthModule`:
   - `RegisterDto`, `LoginDto` (use `@IsEmail()`, `@MinLength(6)`, etc.)
   - `AuthService`: `register` hashes the password; `login` checks it with `bcrypt.compare` and returns a JWT
   - `JwtStrategy`: reads the token and returns `{ id, email, role }`
   - `AuthController`: `POST /auth/register`, `POST /auth/login`, `GET /auth/me`
5. In `common/`:
   - `JwtAuthGuard` (extends `AuthGuard('jwt')`)
   - `@Roles(...)` decorator + `RolesGuard` (reads the roles and compares to `user.role`)
   - `@CurrentUser()` decorator (returns `request.user`)
6. Never return the password: remove it before sending the user back.

**Key idea**

- **Authentication** = *who are you?* → the JWT, checked by `JwtAuthGuard`.
- **Authorization** = *what may you do?* → the role, checked by `RolesGuard`.
- A **guard** runs before the controller and returns true/false. A **DTO** + `ValidationPipe` rejects bad input before your code runs.

**Done when** (all in Swagger)

- [ ] Login as `customer@desk.dev` returns a token
- [ ] `GET /auth/me` without a token → `401`
- [ ] `GET /auth/me` with the token → your user (no password)
- [ ] Register with a bad email → `400`

---

### Phase 4: Tickets REST API (~2h)

**Steps**

1. `TicketsModule` with DTOs: `CreateTicketDto`, `UpdateTicketDto` (status, agentId), `CreateMessageDto`, `QueryTicketsDto` (status, page, limit).
2. `TicketsService`:
   - `create`, `findAll` (filter + pagination), `findOne`, `update`, `remove`
   - `addMessage(ticketId, user, content)` and `getMessages`
   - A helper `assertCanAccess(ticket, user)` that throws `ForbiddenException`:
     - CUSTOMER → only if `ticket.customerId === user.id`
     - AGENT → only if assigned to them or unassigned
     - ADMIN → always
3. `TicketsController`: the 7 routes from the spec. Use `@Roles()` for role-only rules (e.g. `DELETE` is ADMIN only).

**Key idea**: The **role** check ("are you an admin?") goes in a guard. The **ownership** check ("is this *your* ticket?") goes in the service, because the service already loads the ticket.

**Done when**

- [ ] Customer creates a ticket and sees only their own tickets
- [ ] Customer opening someone else's ticket → `403`
- [ ] Agent can set status to `IN_PROGRESS`; customer can't
- [ ] Only admin can delete
- [ ] Messages can be posted and listed

✅ **End of Day 1**: a working, secured REST API on a real database running in Docker.

---

## Day 2: Real-time, Redis, Docker, frontend

### Phase 5: WebSockets (live chat) (~2h)

**Steps**

1. Install `@nestjs/websockets`, `@nestjs/platform-socket.io`, `socket.io`.
2. Create `TicketsGateway`:
   - `handleConnection`: read the token from `socket.handshake.auth.token`, verify it with `JwtService`, save the user on `socket.data.user`. Invalid → `socket.disconnect()`.
   - `join_ticket`: load the ticket, run the same `assertCanAccess`, then `socket.join('ticket:' + id)`.
   - `send_message`: call `ticketsService.addMessage(...)`, then emit `new_message` to the room.
   - `typing`: forward to the room (`socket.to(room).emit(...)`).
   - A method `broadcastMessage(ticketId, message)` that emits `new_message` to the room.
3. In the REST `POST /tickets/:id/messages`, call `addMessage()` and then `gateway.broadcastMessage()`.
4. Test with a small Node script using `socket.io-client` (two terminals = two users).

> **Keeping it simple:** the service only **saves**. The gateway and the controller call the service and then **emit**. This avoids a circular dependency (service ↔ gateway) and keeps the rule: **save first, then emit**.

**Key idea**: REST is request → response. A **WebSocket** stays open, so the server can **push** messages. A **room** is a group of sockets; emitting to `ticket:123` reaches everyone viewing ticket 123.

**Done when**

- [ ] A socket without a valid token is disconnected
- [ ] Two clients in the same room see each other's messages instantly
- [ ] Messages are still there after `GET /tickets/:id/messages`

---

### Phase 6: Redis cache (~45m)

**Steps**

1. Install `ioredis`. Create a small `RedisModule` / `RedisService` that connects using `REDIS_HOST` / `REDIS_PORT`.
2. In `TicketsService.findOne`:
   - try `redis.get('ticket:' + id)` → if found, return it (**cache hit**)
   - otherwise load from Prisma, `redis.set(key, JSON, 'EX', 60)`, return it (**cache miss**)
3. In `update`, `remove` and `addMessage`: `redis.del('ticket:' + id)`.
4. Add a log line for hit/miss so you can see it working.

**Key idea**: Redis is an in-memory key-value store, very fast. This pattern is called **cache-aside**: check the cache, fall back to the DB, store the result. Whenever the data changes, **delete the key** so nobody reads old data.

> Keep the permission check after reading from the cache. The cache stores data, not "who may see it".

**Done when**

- [ ] First `GET /tickets/:id` logs "miss", second logs "hit"
- [ ] After updating the ticket, the next GET shows the new data
- [ ] `docker compose exec redis redis-cli keys "ticket:*"` shows the key

---

### Phase 7: Background jobs with BullMQ (~45m)

**Steps**

1. Install `@nestjs/bullmq`, `bullmq`.
2. In `AppModule`: `BullModule.forRoot({ connection: { host, port } })`.
3. `NotificationsModule`: `BullModule.registerQueue({ name: 'notifications' })` and a `NotificationsProcessor` (extends `WorkerHost`) whose `process(job)` logs `Notified agents of ticket #<id>`.
4. In `TicketsService.create`, after saving: `queue.add('ticket-created', { ticketId }, { attempts: 3 })`.

**Key idea**: Slow work (like sending emails) shouldn't make the user wait. The API puts a **job** in a **queue** (stored in Redis) and responds right away. A **worker** picks the job up later and retries if it fails.

**Done when**

- [ ] Creating a ticket returns immediately, and the log shows "Notified agents of ticket #…"

---

### Phase 8: Run the API in Docker (~45m)

**Steps**

1. `backend/Dockerfile`: install deps, run `prisma generate`, build, start with `node dist/main`.
2. `backend/.dockerignore`: `node_modules`, `dist`, `.env`.
3. Add a `backend` service to `docker-compose.yml`: build `./backend`, port `4000`, `env_file: backend/.env`, `depends_on` postgres and redis.
4. In `.env` for Docker, use `postgres` and `redis` as hosts instead of `localhost`.
5. `docker compose up --build`, then run migrations and the seed with `docker compose exec backend ...` (commands are in the spec).

**Key idea**: Now the **whole backend starts with one command** on any machine. Inside Docker's network, containers find each other by service name, which is why `localhost` no longer works there.

**Done when**

- [ ] `docker compose up --build` starts all 3 services
- [ ] Swagger works at `http://localhost:4000/api/docs`

---

### Phase 9: Minimal frontend (Next.js) (~3h)

Keep it small: **login, ticket list, ticket page with chat**. No fancy UI.

**Steps**

1. `npx create-next-app frontend` (TypeScript, Tailwind, App Router).
2. `lib/api.ts`: a `fetch` wrapper that adds `Authorization: Bearer <token>` (token saved in `localStorage`).
3. `/login`: form → `POST /auth/login` → save token → go to `/tickets`.
4. `/tickets`: list with status, plus a "New ticket" form for customers.
5. `/tickets/[id]`: details + chat. `hooks/useTicketSocket.ts` connects with the token, emits `join_ticket`, listens to `new_message`.
6. `.env.local` uses `localhost` URLs (the browser runs outside Docker).

**Done when**

- [ ] Customer in one window, agent in another (use a private window), chatting live

---

## Final check: 3-minute demo

1. Swagger: `401` without a token, `403` on an admin-only route as customer.
2. Customer creates a ticket → backend log shows the BullMQ job.
3. Agent opens it and sets `IN_PROGRESS`.
4. Live chat between two windows; refresh → messages are still there.

---

## Cut list (if behind schedule, cut in this order)

1. Typing indicator
2. Register page (use the seeded accounts)
3. Phase 8 (keep running the API on your machine; just explain how it would work in Docker)
4. Frontend polish: a plain page that works is enough

**Never cut:** auth guards, the ownership check, the JWT check on the socket, and the live chat.

---

## Later (not for these 2 days)

Socket.IO Redis adapter for multiple API copies, a separate worker container, tests, refresh tokens, rate limiting.
