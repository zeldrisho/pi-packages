---
name: security-review
description: Use this skill when reviewing code or diffs for exploitable security vulnerabilities, including injection, XSS, SSRF, authentication, authorization, cryptography, file handling, secrets, or supply-chain risks. Trace attacker-controlled input through the codebase and report only high-confidence findings with severity and remediation.
allowed-tools: Read Grep Glob Bash Task
---

<!--
Reference material based on OWASP Cheat Sheet Series (CC BY-SA 4.0)
https://cheatsheetseries.owasp.org/
-->

# Security Review Skill

Review code for exploitable security vulnerabilities.

## Reporting standard

Report only high-confidence findings: a vulnerable operation with confirmed
attacker-controlled input. Research the wider codebase to trace data flow,
validation, configuration, and framework protections. Classify uncertain items as
“Needs Verification”.

## Do Not Flag

### General Rules

- Test files (unless explicitly reviewing test security)
- Dead code, commented code, documentation strings
- Patterns using **constants** or **server-controlled configuration**
- Code paths that require prior authentication to reach (note the auth requirement, but still assess authorization, impact, and exploitability)

### Server-Controlled Values (NOT Attacker-Controlled)

These are configured by operators, not controlled by attackers:

| Source                | Example                                      | Why It's Safe                    |
| --------------------- | -------------------------------------------- | -------------------------------- |
| Django settings       | `settings.API_URL`, `settings.ALLOWED_HOSTS` | Set via config/env at deployment |
| Environment variables | `os.environ.get('DATABASE_URL')`             | Deployment configuration         |
| Config files          | `config.yaml`, `app.config['KEY']`           | Server-side files                |
| Framework constants   | `django.conf.settings.*`                     | Not user-modifiable              |
| Hardcoded values      | `BASE_URL = "https://api.internal"`          | Compile-time constants           |

**SSRF Example - NOT a vulnerability:**

```python
# SAFE: URL comes from Django settings (server-controlled)
response = requests.get(f"{settings.SEER_AUTOFIX_URL}{path}")
```

**SSRF Example - IS a vulnerability:**

```python
# VULNERABLE: URL comes from request (attacker-controlled)
response = requests.get(request.GET.get('url'))
```

### Framework-Mitigated Patterns

Check language guides before flagging. Common false positives:

| Pattern                             | Why It's Usually Safe          |
| ----------------------------------- | ------------------------------ |
| Django `{{ variable }}`             | Auto-escaped by default        |
| React `{variable}`                  | Auto-escaped by default        |
| Vue `{{ variable }}`                | Auto-escaped by default        |
| `User.objects.filter(id=input)`     | ORM parameterizes queries      |
| `cursor.execute("...%s", (input,))` | Parameterized query            |
| `innerHTML = "<b>Loading...</b>"`   | Constant string, no user input |

**Only flag these when:**

- Django: `{{ var|safe }}`, `{% autoescape off %}`, `mark_safe(user_input)`
- React: `dangerouslySetInnerHTML={{__html: userInput}}`
- Vue: `v-html="userInput"`
- ORM: `.raw()`, `.extra()`, `RawSQL()` with string interpolation

## Review Process

### 1. Detect Context

What type of code am I reviewing?

| Code Type               | Load These References                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| API endpoints, routes   | `references/authorization.md`, `references/authentication.md`, `references/injection.md` |
| Frontend, templates     | `references/xss.md`, `references/csrf.md`                                                |
| File handling, uploads  | `references/file-security.md`                                                            |
| Crypto, secrets, tokens | `references/cryptography.md`, `references/data-protection.md`                            |
| Data serialization      | `references/deserialization.md`                                                          |
| External requests       | `references/ssrf.md`                                                                     |
| Business workflows      | `references/business-logic.md`                                                           |
| GraphQL, REST design    | `references/api-security.md`                                                             |
| Config, headers, CORS   | `references/misconfiguration.md`                                                         |
| CI/CD, dependencies     | `references/supply-chain.md`                                                             |
| Error handling          | `references/error-handling.md`                                                           |
| Audit, logging          | `references/logging.md`                                                                  |
| LLM or modern threats   | `references/modern-threats.md`                                                           |

### 2. Load Language Guide

Based on file extension or imports:

| Indicators                                      | Guide                      |
| ----------------------------------------------- | -------------------------- |
| `.py`, `django`, `flask`, `fastapi`             | `references/python.md`     |
| `.js`, `.ts`, `express`, `react`, `vue`, `next` | `references/javascript.md` |

### 3. Load Infrastructure Guide (if applicable)

| File Type                     | Guide                  |
| ----------------------------- | ---------------------- |
| `Dockerfile`, `.dockerignore` | `references/docker.md` |

### 4. Verify Exploitability

For each potential finding, confirm:

**Is the input attacker-controlled?**

| Attacker-Controlled (Investigate)              | Server-Controlled (Usually Safe)   |
| ---------------------------------------------- | ---------------------------------- |
| `request.GET`, `request.POST`, `request.args`  | `settings.X`, `app.config['X']`    |
| `request.json`, `request.data`, `request.body` | `os.environ.get('X')`              |
| `request.headers` (most headers)               | Hardcoded constants                |
| `request.cookies` (unsigned)                   | Internal service URLs from config  |
| URL path segments: `/users/<id>/`              | Database content from admin/system |
| File uploads (content and names)               | Signed session data                |
| Database content from other users              | Framework settings                 |
| WebSocket messages                             |                                    |

**Does the framework mitigate this?**

- Check language guide for auto-escaping, parameterization
- Check for middleware/decorators that sanitize

**Is there validation upstream?**

- Input validation before this code
- Sanitization libraries (DOMPurify, bleach, etc.)

---

## Severity Classification

| Severity     | Impact                                          | Examples                                                                 |
| ------------ | ----------------------------------------------- | ------------------------------------------------------------------------ |
| **Critical** | Direct exploit, severe impact, no auth required | RCE, SQL injection to data, auth bypass, hardcoded secrets               |
| **High**     | Exploitable with conditions, significant impact | Stored XSS, SSRF to metadata, IDOR to sensitive data                     |
| **Medium**   | Specific conditions required, moderate impact   | Reflected XSS, CSRF on state-changing actions, path traversal            |
| **Low**      | Defense-in-depth, minimal direct impact         | Missing headers, verbose errors, weak algorithms in non-critical context |

---

## Output Format

````markdown
## Security Review: [File/Component Name]

### Summary

- **Findings**: X (Y Critical, Z High, ...)
- **Risk Level**: Critical/High/Medium/Low
- **Confidence**: High/Mixed

### Findings

#### [VULN-001] [Vulnerability Type] (Severity)

- **Location**: `file.py:123`
- **Confidence**: High
- **Issue**: [What the vulnerability is]
- **Impact**: [What an attacker could do]
- **Evidence**:

  ```python
  [Vulnerable code snippet]
  ```

- **Fix**: [How to remediate]

### Needs Verification

#### [VERIFY-001] [Potential Issue]

- **Location**: `file.py:456`
- **Question**: [What needs to be verified]

If no vulnerabilities found, state: "No high-confidence vulnerabilities identified."
````
