const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

// Usage tracking (in-memory for now)
const usage = {};

const LIMITS = {
  free: 10,
  basic: 999999,
  premium: 999999,
};

function getUserTier(userId) {
  // Everyone is free tier for now — we'll add payments later
  return 'free';
}

function getUsageKey(userId) {
  const now = new Date();
  return `${userId}-${now.getFullYear()}-${now.getMonth()}`;
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'PocketVet server is running!' });
});

// Main AI endpoint
app.post('/chat', async (req, res) => {
  const { messages, pet, userId } = req.body;

  if (!messages || !pet || !userId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Check usage limits
  const tier = getUserTier(userId);
  const key = getUsageKey(userId);
  const currentUsage = usage[key] || 0;
  const limit = LIMITS[tier];

  if (currentUsage >= limit) {
    return res.status(429).json({
      error: 'Monthly limit reached',
      limit,
      usage: currentUsage,
      tier,
      upgradeRequired: true,
    });
  }

  const system = `You are PocketVet, a knowledgeable and caring AI veterinary assistant.

Current pet: ${pet.name}, ${pet.species}, ${pet.breed}, ${pet.age} years old, ${pet.weight}.
Known conditions: ${pet.conditions?.length ? pet.conditions.join(', ') : 'None'}.
Health notes: ${pet.healthNotes || 'None'}

Guidelines:
- Be warm, clear, and caring like a trusted vet friend
- Tailor advice to ${pet.name}'s specific details
- End every health concern with one of:
  🟢 MONITOR AT HOME — safe to watch 24-48 hrs
  🟡 CALL YOUR VET — schedule within 1-3 days
  🔴 GO NOW — seek emergency care immediately
- Keep responses concise and easy to read
- Always remind owners you complement but don't replace professional vet care`;

  try {
    const response = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system,
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err.error?.message || 'AI request failed' });
    }

    const data = await response.json();
    const reply = data.content[0].text;

    // Increment usage
    usage[key] = currentUsage + 1;

    res.json({
      reply,
      usage: currentUsage + 1,
      limit,
      tier,
    });

  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Usage check endpoint
app.get('/usage/:userId', (req, res) => {
  const { userId } = req.params;
  const tier = getUserTier(userId);
  const key = getUsageKey(userId);
  const currentUsage = usage[key] || 0;
  const limit = LIMITS[tier];

  res.json({
    usage: currentUsage,
    limit,
    tier,
    remaining: limit - currentUsage,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PocketVet server running on port ${PORT}`);
});
