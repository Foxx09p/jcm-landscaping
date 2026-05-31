# JCM Staff Role Management

Trusted staff roles are controlled by `config/roles.json` in the private GitHub data repository:

- [Foxx09p/jcm-landscaping-data](https://github.com/Foxx09p/jcm-landscaping-data)

Edit that file in GitHub and add the account email in lowercase:

```json
{
  "version": 1,
  "assignments": {
    "owner@example.com": "owner",
    "admin@example.com": "admin",
    "moderator@example.com": "moderator"
  }
}
```

The account may register before or after it is added. The role takes effect on the next authenticated request, usually within a few seconds.

## Permissions

- `owner`: Full admin access. Can view private buyer details, manage users, review contractor applications, manage jobs, close support tickets, and view analytics.
- `admin`: Operational admin access. Can view private buyer details, manage ordinary users, review contractor applications, manage jobs, close support tickets, and view analytics. Cannot manage staff accounts.
- `moderator`: Review access. Can review contractor applications, change job status, and close support tickets. Cannot view private buyer address or contact details, manage users, view analytics, bypass contractor approval, or bypass Stripe setup.

Only use `owner`, `admin`, or `moderator` in `config/roles.json`. Removing an email removes its privileged access. Do not make the data repository public.
