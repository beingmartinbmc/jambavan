# Security policy

## Supported versions

Security fixes are released on the latest npm version. Upgrade to the current version shown by:

```bash
npm view jambavan version
```

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for [beingmartinbmc/jambavan](https://github.com/beingmartinbmc/jambavan/security/advisories/new). Do not open a public issue or include secrets, private source, memory files, or exploit details in public discussions.

Include the affected version, operating system, MCP host, reproduction steps, impact, and any suggested mitigation. You should receive an acknowledgement within seven days. The maintainer will coordinate validation, remediation, disclosure, and credit through the private advisory.

Source mutation and shell execution are off by default; indexing, memory, failure tracking, and related operations still write local `.jambavan/` state. Reports involving `JAMBAVAN_ALLOW_WRITE`, `JAMBAVAN_ALLOW_BASH`, `JAMBAVAN_ALLOW_OUTSIDE_ROOT`, `JAMBAVAN_ALLOW_SECRETS`, or `JAMBAVAN_BASH_INHERIT_ENV` should state which opt-in gates were enabled.

The secret-file check applies to direct paths passed to file/search/list tools and to the shell working directory. It is not content scanning and does not sandbox commands run through an enabled `bash` tool.
