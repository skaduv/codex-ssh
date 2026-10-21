# Publishing Codex SSH

This repository is ready to distribute as a Codex repo marketplace. It can be
installed with:

```bash
codex plugin marketplace add skaduv/codex-ssh --ref main
codex plugin add codex-ssh@codex-ssh
```

## Official OpenAI Plugin Directory

Codex SSH contains a local stdio MCP server. OpenAI documents this category as
Desktop only. Public submission for local MCP servers currently requires:

1. An approved partner organization allowlisted for local MCP submissions.
2. Organization owner access or `Apps Management Write`.
3. A verified developer or business identity.
4. A tested plugin ZIP uploaded through the OpenAI plugin submission portal.

The plugin cannot be published automatically by pushing to GitHub. Ask the
submitting organization's OpenAI representative to allowlist the organization,
then submit at <https://platform.openai.com/plugins>.

## Package contents

Upload a ZIP whose root contains:

```text
plugin.json
mcp.json
server/dist/index.cjs
scripts/uninstall.mjs
scripts/uninstall-lib.mjs
skills/
LICENSE
README.md
package.json
```

Do not include `node_modules`, `servers.json`, `known_hosts.json`, private keys,
or local credentials.

The self-contained `server/dist/index.cjs` is generated with `npm run build`.

## References

- <https://developers.openai.com/plugins/build/plugins>
- <https://developers.openai.com/plugins/deploy/desktop-only>
- <https://developers.openai.com/plugins/deploy/submission>
