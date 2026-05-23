// Quick BLE diagnostic — logs every peripheral noble discovers, unfiltered.
// Put the plug in pairing mode, run: node ble-scan.mjs
// Press Ctrl-C to stop.

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const noble = require("@stoprocent/noble");

if (typeof noble.on !== "function") {
	// Some noble versions export a factory function
	Object.assign(noble, noble({ extended: false }));
}

noble.on("stateChange", state => {
	console.log("BLE state:", state);
	if (state === "poweredOn") {
		console.log("Scanning for ALL BLE peripherals (Ctrl-C to stop)…\n");
		noble.startScanning([], true); // [] = all services, true = allow duplicates
	}
});

noble.on("discover", peripheral => {
	const { localName, serviceUuids, serviceData, manufacturerData } = peripheral.advertisement;
	const hasMatter = serviceData?.some(d => d.uuid === "fff6");
	console.log(
		`[${new Date().toISOString()}] ${peripheral.address.padEnd(18)} ` +
		`rssi=${String(peripheral.rssi).padStart(4)} ` +
		`connectable=${peripheral.connectable} ` +
		`MATTER=${hasMatter ? "YES ✓" : "no"} ` +
		`name="${localName ?? ""}" ` +
		`services=[${(serviceUuids ?? []).join(",")}] ` +
		`serviceData=${JSON.stringify(serviceData ?? [])}`,
	);
});
