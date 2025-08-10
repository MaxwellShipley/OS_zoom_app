// mockLocalClient.js
import { io } from "socket.io-client";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

// Command-line arguments
const argv = yargs(hideBin(process.argv))
  .option("server", {
    alias: "s",
    type: "string",
    default: "http://localhost:3000",
    describe: "Server URL"
  })
  .option("user", {
    alias: "u",
    type: "string",
    demandOption: true,
    describe: "Origin Story user ID for this local client"
  })
  .help()
  .argv;

// Pretty names for logs
const CMD = {
  0x00: "TEST_CONNECTION",
  0x01: "CONNECTION_ESTABLISHED",
  0x02: "VALIDATE_USER",
  0x03: "USER_VALID",
  0x04: "USER_INVALID",
  0x05: "UPDATE_USER",
  0x06: "USER_UPDATED",
  0x07: "BEGIN_DATA",
  0x08: "DATA_TRANSMISSION",
  0x09: "END_DATA",
  0x0A: "END_CONNECTION",
  0x0B: "BAD_COMMAND",
  0x0C: "BAD_DATA",
  0x0D: "MEETING_INFO",
  0x0E: "REGISTER_LOCAL"
};

const logRecv = (cmd, data) =>
  console.log(`⬇️  os_packet RECV [${CMD[cmd] || cmd}]`, data ? JSON.stringify(data) : "");
const logSend = (dest, cmd, data) =>
  console.log(`⬆️  os_packet SEND → ${dest} [${CMD[cmd] || cmd}]`, data ? JSON.stringify(data) : "");

// State
let meetingId = null;
let sendInterval = null;

// Connect to server
console.log(`🔌 Connecting to server at ${argv.server} as user '${argv.user}'...`);
const socket = io(argv.server);

// On connect, register as local client
socket.on("connect", () => {
  console.log(`✅ Connected to server, socket.id = ${socket.id}`);
  const pkt = { cmd: 0x0E, data: { originStoryUserId: argv.user } }; // REGISTER_LOCAL
  logSend("server", pkt.cmd, pkt.data);
  socket.emit("os_packet", pkt);
});

// Listen for OS packets
socket.on("os_packet", (packet) => {
  if (!packet || typeof packet.cmd === "undefined") return;
  const cmd = Number(packet.cmd);
  const data = packet.data || {};
  logRecv(cmd, data);

  switch (cmd) {
    case 0x01: // CONNECTION_ESTABLISHED or ack from REGISTER_LOCAL
        break;

    case 0x0D: // MEETING_INFO
        meetingId = data.meetingId;
        console.log(`📌 Received MEETING_INFO: meetingId=${meetingId}, originStoryUserId=${data.originStoryUserId}`);
        startSendingProbabilities();
        break;
    case 0x09: // END DATA (stop stream)
        console.log('⏹️ Received END DATA; stopping probability loop');
        stopSendingProbabilities();
        break;


    default:
      break;
  }
});

// Error handlers
socket.on("connect_error", (err) => {
  console.error("❌ Connection error:", err.message || err);
});
socket.on("disconnect", () => {
  console.warn("⚠️ Disconnected from server");
  stopSendingProbabilities();
});

// Start sending probabilities every second
function startSendingProbabilities() {
  if (!meetingId) {
    console.error("❌ Cannot send probabilities — meetingId not set");
    return;
  }
  if (sendInterval) clearInterval(sendInterval);

  console.log("▶️ Starting probability transmission loop (1s interval)...");
  sendInterval = setInterval(() => {
    const authentication = Math.random(); // 0–1 decimal
    const pkt = {
      cmd: 0x08, // DATA_TRANSMISSION
      data: {
        meetingId,
        originStoryUserId: argv.user,
        authentication,
        timestamp: new Date().toISOString()
      }
    };
    logSend(`room:${meetingId}`, pkt.cmd, pkt.data);
    socket.emit("os_packet", pkt);
  }, 1000);
}

// Stop sending
function stopSendingProbabilities() {
  if (sendInterval) {
    clearInterval(sendInterval);
    sendInterval = null;
    console.log("⏹️ Stopped probability transmission loop");
  }
}
