// src/api.js
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const storage = {
  async get(key, defaultValue = null) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/sfgl_data?key=eq.${encodeURIComponent(key)}&select=value`, {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      });
      const rows = await res.json();
      if (rows.length > 0) return rows[0].value;
      return defaultValue;
    } catch (e) {
      const local = localStorage.getItem(key);
      return local ? JSON.parse(local) : defaultValue;
    }
  },

  async set(key, value, onSyncChange) {
    if (onSyncChange) onSyncChange(true);
    try {
      localStorage.setItem(key, JSON.stringify(value));
      await fetch(`${SUPABASE_URL}/rest/v1/sfgl_data`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({ key, value })
      });
    } finally {
      if (onSyncChange) onSyncChange(false);
    }
  }
};