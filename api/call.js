import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory call sessions (resets on redeploy — fine for MVP)
const sessions = {};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).end();
  }

  const callSid = req.body?.CallSid || "unknown";
  const userSpeech = req.body?.SpeechResult || "";
  const businessName = process.env.BUSINESS_NAME || "our office";
  const businessType = process.env.BUSINESS_TYPE || "dental office";
  const businessPhone = process.env.FORWARD_PHONE || "";

  // Initialize session
  if (!sessions[callSid]) {
    sessions[callSid] = { messages: [], appointmentInfo: {} };
  }

  const session = sessions[callSid];

  // First call — greet the caller
  if (!userSpeech) {
    const greeting = `Hello, thank you for calling ${businessName}! I'm an AI assistant. I can help you schedule an appointment, answer questions, or take a message. How can I help you today?`;
    return res.status(200).send(buildTwiML(greeting, true));
  }

  // Add user message to history
  session.messages.push({ role: "user", content: userSpeech });

  try {
    const aiResponse = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: `You are a professional AI receptionist for ${businessName}, a ${businessType}.

Your job:
- Answer questions about the business warmly and professionally
- Collect info to book appointments: name, phone number, preferred date/time, reason for visit
- Take messages if needed
- Keep responses SHORT (under 30 words) — this is a phone call
- Be friendly, clear, and natural
- If someone asks to speak to a human, say you'll transfer them

When you have collected: name, phone, and appointment time — say exactly:
"APPOINTMENT_BOOKED: [name] | [phone] | [time] | [reason]"

If they want to leave a message, collect it and say exactly:
"MESSAGE_TAKEN: [name] | [phone] | [message]"

If they want a human, say exactly: "TRANSFER_CALL"`,
      messages: session.messages.slice(-8),
    });

    const reply = aiResponse.content[0].text;
    session.messages.push({ role: "assistant", content: reply });

    // Check for special actions
    if (reply.includes("TRANSFER_CALL") && businessPhone) {
      delete sessions[callSid];
      return res.status(200).send(buildTransferTwiML(businessPhone));
    }

    if (reply.includes("APPOINTMENT_BOOKED:")) {
      const info = reply.replace("APPOINTMENT_BOOKED:", "").trim();
      // Log appointment (in production, save to database)
      console.log("NEW APPOINTMENT:", info);
      const spoken = `Perfect! I've booked your appointment. You'll receive a confirmation shortly. Is there anything else I can help you with?`;
      delete sessions[callSid];
      return res.status(200).send(buildTwiML(spoken, false));
    }

    if (reply.includes("MESSAGE_TAKEN:")) {
      const msg = reply.replace("MESSAGE_TAKEN:", "").trim();
      console.log("NEW MESSAGE:", msg);
      const spoken = `Got it! I've passed your message along and someone will get back to you soon. Have a great day!`;
      delete sessions[callSid];
      return res.status(200).send(buildTwiML(spoken, false));
    }

    return res.status(200).send(buildTwiML(reply, true));

  } catch (err) {
    console.error(err);
    return res.status(200).send(buildTwiML(
      "I'm sorry, I'm having a technical issue. Please call back in a moment or hold for someone from our team.", false
    ));
  }
}

function buildTwiML(message, listen) {
  const gather = listen ? `
    <Gather input="speech" action="/api/call" method="POST" speechTimeout="2" timeout="8">
      <Say voice="Polly.Joanna">${escapeXml(message)}</Say>
    </Gather>
    <Say voice="Polly.Joanna">I didn't catch that. Could you please repeat?</Say>
    <Redirect method="POST">/api/call</Redirect>` :
    `<Say voice="Polly.Joanna">${escapeXml(message)}</Say><Hangup/>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>${gather}</Response>`;
}

function buildTransferTwiML(phone) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">One moment, I'll transfer you now.</Say>
  <Dial>${phone}</Dial>
</Response>`;
}

function escapeXml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
