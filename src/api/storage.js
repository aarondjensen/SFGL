/**
 * Storage wrapper for localStorage
 * Provides async API for consistency with Supabase
 */

export const storage = {
  async get(key, defaultValue = null) {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : defaultValue;
    } catch (error) {
      console.error(`Storage get error for key "${key}":`, error);
      return defaultValue;
    }
  },

  async set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.error(`Storage set error for key "${key}":`, error);
      throw error;
    }
  },

  async remove(key) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.error(`Storage remove error for key "${key}":`, error);
      throw error;
    }
  },

  async clear() {
    try {
      localStorage.clear();
    } catch (error) {
      console.error('Storage clear error:', error);
      throw error;
    }
  },
};
