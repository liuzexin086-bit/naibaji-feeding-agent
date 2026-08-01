// 静态网页 Supabase 客户端：只包含可公开的项目 URL 与 Publishable Key。
const SUPABASE_URL = 'https://fjkjhohbbnnjfofifzmg.supabase.co'
const SUPABASE_PUBLISHABLE_KEY =
  'sb_publishable_SzGztxZD8kiZiIhtgKCYmg_HHbGhbuo'

if (!window.supabase || typeof window.supabase.createClient !== 'function') {
  console.error('[supabase] SDK 加载失败')
} else {
  window.supabaseClient = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY
  )
}
