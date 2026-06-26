# Render X-Forwarded-For / express-rate-limit fix

- Express now trusts exactly one reverse-proxy hop with `app.set('trust proxy', 1)`.
- The setting is applied before `express-rate-limit` middleware.
- The HTTP server explicitly binds to `0.0.0.0` and Render's `PORT`.
- Rate-limit validation remains enabled; it is not suppressed.

Render start command should remain:

```bash
npm start
```

Seeding should be run separately, not on every restart.
