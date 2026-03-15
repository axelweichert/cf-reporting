# ADR: Email Schedule Enhancements

## Status: APPROVED

## Context

The email scheduling feature has several gaps:
1. Zero Trust report schedules display blank scope name (shows `zoneName` which is empty for account-scoped reports)
2. All schedules are locked to UTC – users cannot select their local timezone
3. Only HTML email is supported – no option to receive PDF reports
4. Each schedule is limited to a single report type – users must create separate schedules for each report on the same zone/account

## Decision

### 1. Fix ZT account name display
- Schedule list uses `s.zoneName` unconditionally; for account-scoped reports, fall back to `s.accountName`

### 2. Timezone support
- Add `timezone` field to `ScheduleConfig` (default: `"UTC"`)
- Add DB migration (v9) to add `timezone TEXT DEFAULT 'UTC'` column
- Add timezone selector in the schedule form with browser auto-detection via `Intl.DateTimeFormat().resolvedOptions().timeZone`
- Pass `timezone` to node-cron's `schedule()` options
- Show the selected timezone in the schedule list and hour selector

### 3. Format selection (HTML / PDF / both)
- Add `format` field to `ScheduleConfig`: `"html" | "pdf" | "both"` (default: `"html"`)
- Add DB migration (v9) for `format TEXT DEFAULT 'html'` column
- For PDF: use Playwright headless Chromium to render the report page server-side, attach as PDF
- For "both": send HTML email with PDF attachment
- Add format selector dropdown in the schedule form

### 4. Multi-report selection
- Change `reportType` from a single value to support multiple values
- Store as JSON array in DB column `report_types` (new column alongside existing `report_type` for backward compat)
- UI: checkboxes grouped by category instead of single dropdown
- Scheduler: iterate over each report type and combine into a single email or send separate emails
- Approach: send one email per report type to keep emails focused and avoid oversized emails

## Consequences
- DB migration v9 adds three columns: `timezone`, `format`, `report_types`
- Existing schedules continue to work unchanged (defaults preserve current behavior)
- PDF generation adds Playwright dependency (already in the project for PDF export)
- Multi-report schedules create multiple emails per cron trigger
