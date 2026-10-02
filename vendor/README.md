# Vendored Roon API packages

Deno can't install `github:` dependencies, and these packages are only published on GitHub, so they are copied here and referenced from `package.json` as `file:` dependencies. All are Apache-2.0 licensed (see each `LICENSE`).

| Package | Source | Commit |
|---|---|---|
| node-roon-api | https://github.com/RoonLabs/node-roon-api | `22e20e4981e5dac7bbfb211009d5006c7c87f567` |
| node-roon-api-audioinput | https://github.com/RoonLabs/node-roon-api-audioinput | `21ff59e52a12cf36a21bb9d3fd546f3e6d70581f` |
| node-roon-api-settings | https://github.com/RoonLabs/node-roon-api-settings | `67cd8ca156c5bcd01ea63833ceaaec6d6a79654d` |
| node-roon-api-status | https://github.com/RoonLabs/node-roon-api-status | `504c918d6da267e03fbb4337befa71ca3d3c7526` |
| node-roon-api-transport | https://github.com/RoonLabs/node-roon-api-transport | `2ee60008a4cdb90c34ff3de58bb4b949067f1d20` |

Changes from upstream:
- Only runtime files are included: docs, CI files and build scripts are left out, and so is `node-roon-api`'s `deploy_key.enc`.
- Each `package.json` has `"type": "commonjs"` added. Deno treats local (non-npm) `.js` files without it as ES modules, and these are CommonJS.
- `node-roon-api/sood.js` no longer uses the `ip` package (unmaintained, CVE-2024-29415) or the deprecated `node-uuid`: the subnet broadcast address is computed inline and `_tid` comes from `crypto.randomUUID()`. Both are removed from its `package.json`.
- `new Buffer(n)` (deprecated, DEP0005) is replaced with `Buffer.alloc(n)` in `sood.js` and `moo.js`.

Deno doesn't install the dependencies of `file:` packages. `node-roon-api` needs `ws`, so it is listed in the root `package.json` instead.

To update a package, copy the files again from the new commit, re-apply the changes above, and update the table above.
