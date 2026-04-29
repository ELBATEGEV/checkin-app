// Supabase 配置
const SUPABASE_URL = 'https://azktetpcsxizlonodmwk.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_uj_Xe2XzCMzVazAkoWJplA_12phDHaC';

// 初始化 Supabase 客户端
let supabaseClient = null;

function initSupabase() {
  supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    }
  });
  return supabaseClient;
}
