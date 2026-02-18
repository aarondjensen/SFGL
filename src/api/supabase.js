import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

/**
 * Player Rankings API
 * Stores OWGR rankings in Supabase for cross-device sync
 */

export const playerRankingsApi = {
  /**
   * Fetch all player rankings from Supabase
   */
  async getAll() {
    const { data, error } = await supabase
      .from('player_rankings')
      .select('*')
      .order('world_rank', { ascending: true });
    
    if (error) {
      console.error('Error fetching player rankings:', error);
      throw error;
    }
    
    return data || [];
  },

  /**
   * Update all player rankings (replaces entire list)
   */
  async updateAll(players) {
    try {
      // Delete all existing rankings
      const { error: deleteError } = await supabase
        .from('player_rankings')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all rows
      
      if (deleteError) throw deleteError;
      
      // Insert new rankings
      const rows = players.map(p => ({
        name: p.name,
        world_rank: p.worldRank,
        pga_tour_id: p.pgaTourId || null,
      }));
      
      const { data, error: insertError } = await supabase
        .from('player_rankings')
        .insert(rows)
        .select();
      
      if (insertError) throw insertError;
      
      // Update metadata
      await supabase
        .from('app_metadata')
        .upsert({
          key: 'player_rankings_last_updated',
          value: new Date().toISOString(),
        });
      
      return data;
    } catch (error) {
      console.error('Error updating player rankings:', error);
      throw error;
    }
  },

  /**
   * Get last updated timestamp
   */
  async getLastUpdated() {
    const { data, error } = await supabase
      .from('app_metadata')
      .select('value')
      .eq('key', 'player_rankings_last_updated')
      .single();
    
    if (error && error.code !== 'PGRST116') { // Ignore "not found" error
      console.error('Error fetching last updated:', error);
    }
    
    return data?.value || null;
  },
};
