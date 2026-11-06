// Lists your groups (name + ID). Falls back to printing the ID of any group that gets a message.
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

const idOf = (id) => id && (id.$1 || id._serialized);

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true, args: ["--no-sandbox"] },
});

const printed = new Set();

client.on("qr", (qr) => qrcode.generate(qr, { small: true }));

client.on("ready", async () => {
  await new Promise((r) => setTimeout(r, 8000)); // let WhatsApp Web finish loading

  try {
    const chats = await client.getChats();

    const groups = chats.filter((chat) => chat.isGroup);

    console.log(`Found ${groups.length} groups:\n`);

    for (const group of groups) {
      console.log({
        name: group.name,
        id: group.id._serialized,
      });
    }
  } catch (e) {
    console.error("List method failed:", e.message);
  }

  console.log(
    "\nFallback: wait for a message in the group (or send one yourself).\n",
  );
});

async function handle(msg) {
  const id = msg.fromMe ? msg.to : msg.from;
  if (!id || !id.endsWith("@g.us") || printed.has(id)) return;
  printed.add(id);
  console.log("--------------------------------");
  console.log("Group ID :", id);
  console.log("Sent by  :", msg._data?.notifyName || msg.author || "unknown");
  console.log("Message  :", (msg.body || "").slice(0, 60).replace(/\n/g, " "));
}

client.on("message", handle);
client.on("message_create", handle);

client.initialize();
