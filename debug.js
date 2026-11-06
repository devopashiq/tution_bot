// Prints what the bot actually receives. Use it to check the library works.
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true, args: ['--no-sandbox'] },
});

client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('Ready. Waiting for messages...'));
client.on('message', msg => {
  console.log('--------------------------------');
  console.log('from  :', msg.from);
  console.log('author:', msg.author);
  console.log('id    :', msg.id);
  console.log('body  :', (msg.body || '').slice(0, 60));
});
client.initialize();
