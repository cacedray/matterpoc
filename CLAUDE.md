# SwitchBot Plug Mini – Matter.js POC

## What this project is

Proof-of-concept for connecting a **SwitchBot Plug Mini** to a local Node.js controller via the **Matter protocol** using the `matter.js` library. No cloud, no SwitchBot app required after initial commissioning. Intended as a building block for a self-hosted home automation system.

## Project structure

```
mattertest/
├── index.js          ← entire POC (single file, run this)
├── package.json
└── node_modules/
```

Commissioning data (fabric keys, node IDs) persists at:
`%AppData%\matter\node0\`  (Windows default, created automatically)

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| `@matter/main` | 0.12.6 | Matter protocol core |
| `@matter/nodejs` | 0.12.6 | Node.js platform (crypto, disk storage, network) |
| `@matter/nodejs-ble` | 0.12.6 | BLE support for first-time WiFi commissioning |

All three are `"type": "module"` ESM packages.

## How to run

```bash
# Install dependencies (already done)
npm install

# First run – put plug in pairing mode first (hold button ~5 s, LED blinks)
node index.js

# Subsequent runs – plug already commissioned, just connect
node index.js
```

### Configuration

Edit the `CONFIG` block near the top of `index.js`, or use env vars:

```bash
WIFI_SSID=MyNetwork WIFI_PASSWORD=secret PAIRING_CODE=12345678901 node index.js
```

- `WIFI_SSID` / `WIFI_PASSWORD` — your 2.4 GHz WiFi (only needed on first commissioning)
- `PAIRING_CODE` — 11-digit manual pairing code from the device label or the SwitchBot app (Matter settings)

### CLI commands (once connected)

| Command | Action |
|---|---|
| `on` | Turn plug ON |
| `off` | Turn plug OFF |
| `toggle` | Toggle relay |
| `status` | Read live on/off state |
| `power` | Read power/energy measurement data |
| `exit` | Clean shutdown |

## Architecture

### Controller node
`ServerNode.create(ServerNode.RootEndpoint.with(ControllerBehavior))` — even for a controller the local Matter node is a `ServerNode`; `ControllerBehavior` adds commissioning capabilities for remote devices.

### Commissioning flow (first run only)
1. `controller.nodes.commission({ discriminator, passcode, timeoutSeconds })` triggers `CommissioningDiscovery`
2. Discovery scans via **mDNS** (IP) and **BLE** in parallel
3. Device found → PASE session → WiFi credentials pushed to device → device joins WiFi → CASE session → `CommissioningComplete`
4. Commissioned node stored in local storage and reloaded on next run

### WiFi credential injection (workaround)
`matter.js` v0.12's high-level `CommissioningClient.commission()` builds the internal `LocatedNodeCommissioningOptions` object without exposing a `wifiNetwork` field. We patch `ControllerCommissioner.prototype.commission` at the protocol layer to inject `wifiNetwork` before the call hits the commissioning flow. This is documented in `injectWifiIntoCommissioner()` in `index.js`.

### Cluster interaction (post-commissioning)
`ClientNode.interaction` is marked `NotImplementedError` in v0.12. Instead we use the lower-level **`InteractionClientProvider`** (from `@matter/protocol`):

```js
const clientProvider = controller.env.get(InteractionClientProvider);
const client = await clientProvider.getInteractionClient(peerAddress, { ... });
// client has: getAttribute, setAttribute, invoke, subscribeAttribute, getMultipleAttributes, ...
```

### OnOff cluster
Cluster ID `6`, endpoint `1`.
- Read: `client.getAttribute({ ..., attribute: OnOff.Cluster.attributes.onOff })`
- Commands: `client.invoke({ ..., command: OnOff.Cluster.commands.on/off/toggle, request: {} })`
- Subscribe: `client.subscribeAttribute({ ..., listener: value => ... })`

### Power data
SwitchBot Plug Mini may expose:
- `ElectricalPowerMeasurement` cluster — ID `0x0090` (144)
- `ElectricalEnergyMeasurement` cluster — ID `0x0091` (145)

Read via `client.getMultipleAttributes({ attributes: [{ endpointId: 1, clusterId: 0x0090 }] })`. Wrapped in try/catch since support varies.

## Known limitations / gotchas

- **BLE on Windows**: requires Bluetooth to be enabled in Windows Settings. The `@matter/nodejs-ble` package uses `@abandonware/noble` which binds to the Windows Bluetooth stack. If it fails to find the BLE adapter, IP-only discovery still works for devices already on the network.
- **IP-only mode**: if the plug was previously paired (has WiFi) and is in an "open commissioning window", it can be commissioned over IP without BLE and without providing WiFi credentials.
- **Re-commissioning**: if you need to commission again from scratch, delete `%AppData%\matter\node0\` and factory-reset the plug (hold button ~10 s).
- **matter.js v0.12 is evolving**: the `ClientNode` high-level API (cluster behaviors as client-side state) is a planned feature not yet implemented. Monitor https://github.com/project-chip/matter.js for progress.
