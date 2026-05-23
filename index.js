/**
 * SwitchBot Plug Mini - Matter.js POC
 *
 * Commissions a SwitchBot Plug Mini via Matter and provides a CLI to:
 *  - Turn the plug on / off / toggle
 *  - Read the current on/off state
 *  - Read power measurement data if the device exposes it
 *
 * FIRST RUN  – put the plug into pairing mode (hold the button ~5 s until the LED blinks),
 *              then run: node index.js
 * SUBSEQUENT – plug is already commissioned; just run: node index.js
 *
 * Config via env vars (or edit the CONFIG block below):
 *   WIFI_SSID      Your 2.4 GHz WiFi network name
 *   WIFI_PASSWORD  WiFi password
 *   PAIRING_CODE   11-digit manual pairing code (from device label or SwitchBot app)
 */

// ─── 1. Platform extensions (must be first) ──────────────────────────────────
import "@matter/nodejs"; // Node.js crypto, network, disk storage

// ─── 2. Matter.js core ───────────────────────────────────────────────────────
import { ServerNode, ControllerBehavior } from "@matter/main";
import {
	Ble,
	ControllerCommissioner,
	InteractionClientProvider,
	NodeDiscoveryType,
} from "@matter/protocol";
import { ManualPairingCodeCodec } from "@matter/types";
import { OnOff } from "@matter/main/clusters/on-off";

// ─── 3. BLE provider registration ────────────────────────────────────────────
// @matter/nodejs-ble does NOT auto-register — we must wire it up explicitly.
// Use a singleton so noble is initialised only once regardless of how many
// times Ble.get() is called internally.
import { NodeJsBle } from "@matter/nodejs-ble";
const bleInstance = new NodeJsBle({});
Ble.get = () => bleInstance;
console.log("BLE provider registered. Ble.enabled =", Ble.enabled);

// ─── 4. Node.js built-ins ────────────────────────────────────────────────────
import readline from "readline";

// ═══════════════════════════════════════════════════════════════════════════════
//  CONFIGURATION  — edit here or use env vars
// ═══════════════════════════════════════════════════════════════════════════════
const CONFIG = {
	wifi: {
		// Your 2.4 GHz WiFi (needed only during the very first commissioning)
		ssid: process.env.WIFI_SSID ?? "Home Wifi",
		password: process.env.WIFI_PASSWORD ?? "12Qw/er34",
	},
	// 11-digit manual pairing code printed on the device or shown in the SwitchBot app
	// Example: "34970112332"  (this is the default test code; replace with yours)
	pairingCode: process.env.PAIRING_CODE ?? "04859014777",
};
// ═══════════════════════════════════════════════════════════════════════════════

// Inject WiFi credentials into the internal commissioning flow.
// matter.js @0.12 does not yet expose a high-level API for this, so we patch
// ControllerCommissioner.prototype.commission to add wifiNetwork when present.
injectWifiIntoCommissioner();

// ─── Entry point ─────────────────────────────────────────────────────────────
main().catch((err) => {
	console.error("Fatal error:", err.message ?? err);
	process.exit(1);
});

async function main() {
	console.log("╔══════════════════════════════════════╗");
	console.log("║  SwitchBot Plug Mini – Matter.js POC  ║");
	console.log("╚══════════════════════════════════════╝\n");

	// ── Create the Matter controller node ──────────────────────────────────
	// ServerNode is used even for a controller (it's our local Matter node on
	// the fabric).  ControllerBehavior enables commissioning of remote devices.
	const controller = await ServerNode.create(
		ServerNode.RootEndpoint.with(ControllerBehavior),
		{
			// network.ble: false → NetworkServer won't advertise via BLE (bleno not installed)
			// controller.ble: true  → ControllerBehavior still sets up BLE scanner + central interface
			network: { ble: false },
			controller: {
				adminFabricLabel: "switchbot-home-poc",
				ble: true,
			},
		},
	);

	process.on("SIGINT", async () => {
		console.log("\nShutting down…");
		await controller.close();
		process.exit(0);
	});

	// ── Commission or reconnect ─────────────────────────────────────────────
	const knownNodes = [...controller.nodes];
	let deviceNode;

	if (knownNodes.length > 0) {
		console.log(
			`Found ${knownNodes.length} previously commissioned device(s).`,
		);
		deviceNode = knownNodes[0];
		console.log(`Reconnecting to: ${deviceNode.id}\n`);
	} else {
		deviceNode = await commissionDevice(controller);
	}

	// ── Bring the commissioned node online (establishes CASE session) ───────
	console.log("Connecting to device…");
	await deviceNode.start();
	console.log("Connected!\n");

	// ── Get a fully-featured InteractionClient for the peer ─────────────────
	const peerAddress = deviceNode.state.commissioning.peerAddress;
	if (!peerAddress) {
		throw new Error(
			"Device peer address not available – was commissioning successful?",
		);
	}

	const clientProvider = controller.env.get(InteractionClientProvider);
	const client = await clientProvider.getInteractionClient(peerAddress, {
		discoveryType: NodeDiscoveryType.TimedDiscovery,
		timeoutSeconds: 30,
	});

	// ── Read current on/off state ───────────────────────────────────────────
	const initialState = await readOnOff(client);
	console.log(`Plug is currently: ${fmtState(initialState)}\n`);

	// ── Subscribe to on/off changes ─────────────────────────────────────────
	await client.subscribeAttribute({
		endpointId: 1,
		clusterId: OnOff.Cluster.id,
		attribute: OnOff.Cluster.attributes.onOff,
		minIntervalFloorSeconds: 0,
		maxIntervalCeilingSeconds: 30,
		listener: (value) =>
			console.log(`\n[state change] Plug → ${fmtState(value)}`),
	});

	// ── Try to read power measurement data ─────────────────────────────────
	await tryReadPower(client);

	// ── Interactive CLI ─────────────────────────────────────────────────────
	startCLI(client);
}

// ─── Commission a new device ──────────────────────────────────────────────────
async function commissionDevice(controller) {
	console.log("No previously commissioned devices found.");
	console.log("──────────────────────────────────────────");
	console.log(" Put the SwitchBot Plug Mini into pairing mode:");
	console.log(
		"   Hold the button for ~5 seconds until the LED blinks rapidly.",
	);
	console.log(`\n Pairing code: ${CONFIG.pairingCode}`);
	console.log(` WiFi SSID:    ${CONFIG.wifi.ssid}`);
	console.log("──────────────────────────────────────────\n");

	const pairingData = ManualPairingCodeCodec.decode(CONFIG.pairingCode);
	console.log(
		`Decoded pairing code → passcode: ${pairingData.passcode}, ` +
			`discriminator: ${pairingData.longDiscriminator ?? pairingData.shortDiscriminator}`,
	);

	const discoveryFilter =
		pairingData.longDiscriminator !== undefined
			? { longDiscriminator: pairingData.longDiscriminator }
			: pairingData.shortDiscriminator !== undefined
				? { shortDiscriminator: pairingData.shortDiscriminator }
				: {};

	console.log("\nSearching for device (BLE + IP)… this may take up to 120 s.");

	await controller.nodes.commission({
		...discoveryFilter,
		passcode: pairingData.passcode,
		timeoutSeconds: 120,
	});

	console.log("\nDevice commissioned successfully!");
	// Re-fetch from controller.nodes — the returned node isn't fully
	// initialised for start() immediately after commission() in v0.12.
	return [...controller.nodes][0];
}

// ─── Read the OnOff attribute ─────────────────────────────────────────────────
async function readOnOff(client) {
	return client.getAttribute({
		endpointId: 1,
		clusterId: OnOff.Cluster.id,
		attribute: OnOff.Cluster.attributes.onOff,
		alwaysRequestFromRemote: true,
	});
}

// ─── Send OnOff commands ──────────────────────────────────────────────────────
function invokeOnOff(client, command) {
	return client.invoke({
		endpointId: 1,
		clusterId: OnOff.Cluster.id,
		command,
		request: {},
	});
}

// ─── Try to read power measurement data ──────────────────────────────────────
async function tryReadPower(client) {
	// SwitchBot Plug Mini exposes power data via ElectricalPowerMeasurement (0x0090)
	// and ElectricalEnergyMeasurement (0x0091) on endpoint 1.
	// We read all attributes from those clusters and display whatever we get.
	const powerClusterIds = [0x0090, 0x0091];

	for (const clusterId of powerClusterIds) {
		try {
			const attrs = await client.getMultipleAttributes({
				attributes: [{ endpointId: 1, clusterId }],
			});
			if (attrs.length > 0) {
				const name =
					clusterId === 0x0090
						? "ElectricalPowerMeasurement"
						: "ElectricalEnergyMeasurement";
				console.log(`\n[power] ${name} attributes:`);
				for (const { path, value } of attrs) {
					console.log(
						`  attr 0x${path.attributeId?.toString(16).padStart(4, "0")} = ${JSON.stringify(value)}`,
					);
				}
			}
		} catch {
			// Cluster not supported or not readable – silently skip
		}
	}
}

// ─── Interactive CLI ──────────────────────────────────────────────────────────
function startCLI(client) {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
	console.log("  Commands:");
	console.log("    on      – turn plug ON");
	console.log("    off     – turn plug OFF");
	console.log("    toggle  – toggle plug");
	console.log("    status  – read current state");
	console.log("    power   – read power data");
	console.log("    exit    – disconnect and quit");
	console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

	const prompt = () => rl.question("> ", handleCommand);

	async function handleCommand(raw) {
		const cmd = raw.trim().toLowerCase();
		try {
			switch (cmd) {
				case "on":
					await invokeOnOff(client, OnOff.Cluster.commands.on);
					console.log("→ ON command sent");
					break;
				case "off":
					await invokeOnOff(client, OnOff.Cluster.commands.off);
					console.log("→ OFF command sent");
					break;
				case "toggle":
					await invokeOnOff(client, OnOff.Cluster.commands.toggle);
					console.log("→ TOGGLE command sent");
					break;
				case "status": {
					const state = await readOnOff(client);
					console.log(`→ Plug is ${fmtState(state)}`);
					break;
				}
				case "power":
					await tryReadPower(client);
					break;
				case "exit":
				case "quit":
					rl.close();
					process.exit(0);
					return;
				default:
					if (cmd)
						console.log(`Unknown command: "${cmd}". Type "exit" to quit.`);
			}
		} catch (err) {
			console.error(`Command failed: ${err.message}`);
		}
		prompt();
	}

	prompt();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtState(onOff) {
	return onOff ? "ON  ✓" : "OFF ✗";
}

// Patch ControllerCommissioner to forward WiFi credentials.
// The matter.js v0.12 high-level CommissioningClient.commission() builds the
// LocatedNodeCommissioningOptions object internally without exposing wifiNetwork,
// so we intercept at the lower layer where it is supported.
function injectWifiIntoCommissioner() {
	if (CONFIG.wifi.ssid === "YourWifiSSID") return; // not configured, skip

	const original = ControllerCommissioner.prototype.commission;
	ControllerCommissioner.prototype.commission = function (options) {
		if (!options.wifiNetwork) {
			options = {
				...options,
				wifiNetwork: {
					wifiSsid: CONFIG.wifi.ssid,
					wifiCredentials: CONFIG.wifi.password,
				},
			};
		}
		return original.call(this, options);
	};
}
