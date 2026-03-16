# Role-Based Access Control (RBAC)

## Status: APPROVED

## Context

The application currently has a single APP_PASSWORD gate – any authenticated user is effectively an admin. When the instance is shared, every user inherits full control: data collection triggers, email schedule management, database wipe/restore, and unrestricted Cloudflare API proxy access.

Security finding #2 identified this as a medium-severity issue.

## Decision

Introduce two roles with separate passwords:

| Role | Password Env Var | Access |
|------|-----------------|--------|
| **Operator** | `APP_PASSWORD` (existing) | Full access – everything the current single role can do |
| **Viewer** | `VIEWER_PASSWORD` (new) | Read-only dashboards, PDF/HTML export, view schedules/status |

### Login Flow

The login page gains a role selector dropdown (Operator / Viewer). The entered password is validated against the corresponding env var. The selected role is stored in the iron-session cookie as `role: "operator" | "viewer"`.

If only `APP_PASSWORD` is set and `VIEWER_PASSWORD` is not, the dropdown is hidden and login works exactly as before (operator role assumed).

### Route Protection

New helper `requireOperator()` returns 403 for viewer sessions. Applied to:

- `POST /api/collector/trigger` – trigger collection
- `POST /api/email/send` – send email
- `POST/DELETE/PATCH /api/email/schedules` – manage schedules
- `GET/POST /api/backup` – backup/wipe
- `POST /api/backup/restore` – restore
- `POST /api/email/smtp/test` – test SMTP

Viewer-accessible (read-only):

- All dashboard pages and data-fetching GET routes
- `POST /api/export/pdf`, `POST /api/export/html` – export
- `GET /api/email/schedules`, `GET /api/email/status`, `GET /api/email/smtp` – view config
- `GET /api/collector/status`, `GET /api/collector/snapshots` – view status
- `GET /api/data/*` – query data

### UI Changes

- Login page: role dropdown (hidden when VIEWER_PASSWORD not configured)
- Sidebar: hide Data Collection, Email Schedules, Backup & Restore sections for viewers
- Filter bar: hide admin-only actions for viewers
- Session API: expose `role` and `viewerEnabled` to client

### Session Shape Change

```typescript
export interface SessionData {
  // ... existing fields
  role?: "operator" | "viewer";
}
```

## Consequences

- Zero breaking change when VIEWER_PASSWORD is not set – existing deployments unaffected
- Viewers cannot escalate to operator without knowing the operator password
- The Cloudflare API proxy (`/api/cf/[...path]`) remains accessible to viewers for live data queries (needed for dashboard rendering)
