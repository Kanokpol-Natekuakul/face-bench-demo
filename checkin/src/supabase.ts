import { createClient } from '@supabase/supabase-js'

export const url = 'https://bzfdvdnphxtemqqhsbpj.supabase.co'
const key = 'sb_publishable_Iwpim3BYI9IJtGBrDRHEIg_rpt9CsIY'

export const supabase = createClient(url, key)
