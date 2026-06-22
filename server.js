const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const RESEND_API = 'https://api.resend.com/emails';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const LIMITS = {
  free: 8,
  basic: 999999,
  premium: 999999,
};

const VALID_TIERS = ['free', 'basic', 'premium'];

function getUsageKey(userId) {
  const now = new Date();
  return `${userId}-${now.getFullYear()}-${now.getMonth()}`;
}

// Reads a user's current tier from Supabase. Defaults to 'free' if no
// row exists yet (brand new user, or a user who has never reported a tier).
//
// NOTE: this is a self-reported tier — the app tells the server what tier
// the user is on after RevenueCat confirms a purchase or restore. This is
// fine for launch, but a more tamper-resistant approach down the line is
// to verify tier changes via a RevenueCat webhook instead of trusting the
// client's POST /tier call directly.
async function getUserTier(userId) {
  const { data, error } = await supabase
    .from('user_tiers')
    .select('tier')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    console.error('Supabase tier read error:', error.message);
    return 'free';
  }
  return data?.tier || 'free';
}

// Writes a user's tier to Supabase.
async function setUserTier(userId, tier) {
  const { error } = await supabase
    .from('user_tiers')
    .upsert({ id: userId, tier, updated_at: new Date().toISOString() });

  if (error) {
    console.error('Supabase tier write error:', error.message);
    return false;
  }
  return true;
}

// Reads the current usage count for a key from Supabase.
// Returns 0 if no row exists yet (first question of the month for that user).
async function getUsageCount(key) {
  const { data, error } = await supabase
    .from('usage_tracking')
    .select('count')
    .eq('id', key)
    .maybeSingle();

  if (error) {
    console.error('Supabase read error:', error.message);
    return 0;
  }
  return data?.count || 0;
}

// Increments (or creates) the usage row for a key, and returns the new count.
async function incrementUsageCount(key) {
  const current = await getUsageCount(key);
  const next = current + 1;

  const { error } = await supabase
    .from('usage_tracking')
    .upsert({ id: key, count: next, updated_at: new Date().toISOString() });

  if (error) {
    console.error('Supabase write error:', error.message);
  }
  return next;
}

// Send welcome email via Resend
async function sendWelcomeEmail(name, email) {
  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'PocketVet <onboarding@resend.dev>',
        to: email,
        subject: 'Welcome to PocketVet! 🐾',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
            <div style="background: #1a6b4a; border-radius: 16px; padding: 32px; text-align: center; margin-bottom: 32px;">
              <h1 style="color: white; font-size: 32px; margin: 0 0 8px 0;">PocketVet 🐾</h1>
              <p style="color: rgba(255,255,255,0.8); margin: 0; font-size: 16px;">Your AI Pet Health Assistant</p>
            </div>
            
            <h2 style="color: #1a1f1c; font-size: 24px;">Welcome, ${name}! 👋</h2>
            
            <p style="color: #5a6460; font-size: 16px; line-height: 1.6;">
              We're so excited to have you join PocketVet! You now have an AI-powered vet assistant in your pocket, ready to help with your pet's health questions anytime.
            </p>

            <div style="background: #e1f5ee; border-radius: 12px; padding: 24px; margin: 24px 0;">
              <h3 style="color: #1a6b4a; margin: 0 0 16px 0;">What you can do with PocketVet:</h3>
              <p style="margin: 8px 0; color: #1a1f1c;">💬 Ask any pet health question</p>
              <p style="margin: 8px 0; color: #1a1f1c;">📋 Use the symptom checker</p>
              <p style="margin: 8px 0; color: #1a1f1c;">🚨 Get emergency triage guidance</p>
              <p style="margin: 8px 0; color: #1a1f1c;">🐾 Manage multiple pet profiles</p>
            </div>

            <div style="background: #faeeda; border-radius: 12px; padding: 20px; margin: 24px 0;">
              <p style="color: #ba7517; margin: 0; font-size: 14px;">
                <strong>Your Free Plan:</strong> You have <strong>8 free questions</strong> this month. Upgrade anytime for unlimited access!
              </p>
            </div>

            <p style="color: #5a6460; font-size: 16px; line-height: 1.6;">
              Open the app and add your first pet to get started. Our AI vet is ready when you are!
            </p>

            <div style="border-top: 1px solid #e5e7eb; margin-top: 32px; padding-top: 24px; text-align: center;">
              <p style="color: #8a9590; font-size: 13px; margin: 0;">
                PocketVet — AI Pet Health Assistant<br/>
                <em>Always consult a licensed veterinarian for medical decisions.</em>
              </p>
            </div>
          </div>
        `,
      }),
    });
    if (res.ok) {
      console.log('Welcome email sent to:', email);
    } else {
      const err = await res.json();
      console.log('Email error:', err);
    }
  } catch (err) {
    console.log('Email send failed:', err.message);
  }
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'PocketVet server is running!' });
});

// Welcome email endpoint
app.post('/welcome', async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email required' });
  }
  await sendWelcomeEmail(name, email);
  res.json({ success: true });
});

// Updates a user's tier (called by the app right after RevenueCat confirms
// a purchase or restore). Validates the tier value to prevent bad data.
app.post('/tier', async (req, res) => {
  const { userId, tier } = req.body;

  if (!userId || !tier) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!VALID_TIERS.includes(tier)) {
    return res.status(400).json({ error: 'Invalid tier' });
  }

  const success = await setUserTier(userId, tier);
  if (!success) {
    return res.status(500).json({ error: 'Failed to update tier' });
  }
  res.json({ success: true, tier });
});

// Main AI endpoint
app.post('/chat', async (req, res) => {
  const { messages, pet, userId } = req.body;

  if (!messages || !pet || !userId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const tier = await getUserTier(userId);
  const key = getUsageKey(userId);
  const limit = LIMITS[tier];
  const currentUsage = await getUsageCount(key);

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
- Formatting rules (strict):
  - Never use markdown headers or hashtags (no #, ##, ### etc. anywhere in your response)
  - Never use asterisk bullet points or asterisks for emphasis markup other than **bold** for genuinely key terms (symptoms, actions, timeframes)
  - For lists, use a hyphen followed by a space ("- like this") on its own line, never numbers, asterisks, or bullet symbols
  - Do not use any other special formatting symbols (no underscores, no tildes, no backticks)
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

    const newUsage = await incrementUsageCount(key);

    res.json({ reply, usage: newUsage, limit, tier });

  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Usage check endpoint
app.get('/usage/:userId', async (req, res) => {
  const { userId } = req.params;
  const tier = await getUserTier(userId);
  const key = getUsageKey(userId);
  const limit = LIMITS[tier];
  const currentUsage = await getUsageCount(key);
  res.json({ usage: currentUsage, limit, tier, remaining: limit - currentUsage });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PocketVet server running on port ${PORT}`);
});
