-- Create player_rankings table
CREATE TABLE IF NOT EXISTS player_rankings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  world_rank INTEGER NOT NULL,
  pga_tour_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index on world_rank for sorting
CREATE INDEX IF NOT EXISTS idx_player_rankings_world_rank 
  ON player_rankings(world_rank);

-- Create index on name for searching
CREATE INDEX IF NOT EXISTS idx_player_rankings_name 
  ON player_rankings(name);

-- Create app_metadata table for storing timestamps and other metadata
CREATE TABLE IF NOT EXISTS app_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE player_rankings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_metadata ENABLE ROW LEVEL SECURITY;

-- Allow public read access (anyone can view rankings)
CREATE POLICY "Allow public read access on player_rankings"
  ON player_rankings
  FOR SELECT
  TO public
  USING (true);

-- Allow public read access to metadata
CREATE POLICY "Allow public read access on app_metadata"
  ON app_metadata
  FOR SELECT
  TO public
  USING (true);

-- Only authenticated users can update rankings (for commissioner)
-- You can make this more restrictive with specific user checks if needed
CREATE POLICY "Allow authenticated users to update player_rankings"
  ON player_rankings
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Allow authenticated users to update app_metadata"
  ON app_metadata
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Add updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add trigger to player_rankings
CREATE TRIGGER update_player_rankings_updated_at
  BEFORE UPDATE ON player_rankings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Add trigger to app_metadata
CREATE TRIGGER update_app_metadata_updated_at
  BEFORE UPDATE ON app_metadata
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
