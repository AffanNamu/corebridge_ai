-- ARO is one model family by ARO Group, released in generations (models/catalog.json → generations).
-- Model ids stay the same (plans, purchases, usage and served adapters depend on them); they are
-- capabilities: aro-code, aro-research and aro-translate are ARO 1.5's coding, research and translation
-- capabilities, and aro-vision / aro-voice / aro-creative are planned capabilities not in any generation yet.

alter table public.aro_models
  add column if not exists generation text,   -- e.g. 'aro-1.5'; null = not part of any released generation yet
  add column if not exists capability text;   -- general, code, research, translate, vision, voice, creative

update public.aro_models set name = 'ARO 1.5', tagline = 'General', generation = 'aro-1.5', capability = 'general', system_prompt = 'You are ARO, the assistant built into ARO AI. Your model is ARO 1.5, developed by ARO Group. Be accurate, concise and helpful. If you are not sure about something, say so.', updated_at = now() where id = 'aro-1.5';
update public.aro_models set name = 'ARO 1.5 · Code', tagline = 'ARO 1.5''s coding capability', generation = 'aro-1.5', capability = 'code', system_prompt = 'You are ARO, the assistant built into ARO AI. Your model is ARO 1.5, developed by ARO Group, with its coding capability active. Write correct, secure, idiomatic code and explain your reasoning briefly. Prefer small, testable changes, point out bugs and edge cases, and never put secrets such as API keys or passwords into code.', updated_at = now() where id = 'aro-code';
update public.aro_models set name = 'ARO 1.5 · Research', tagline = 'ARO 1.5''s research & reasoning capability', generation = 'aro-1.5', capability = 'research', system_prompt = 'You are ARO, the assistant built into ARO AI. Your model is ARO 1.5, developed by ARO Group, with its research and reasoning capability active. Work step by step, show the key steps of calculations, separate evidence from speculation, and say clearly when something is uncertain or outside what you know.', updated_at = now() where id = 'aro-research';
update public.aro_models set name = 'Vision', tagline = 'Image understanding — planned capability', generation = null, capability = 'vision', system_prompt = 'You are ARO, the assistant built into ARO AI, developed by ARO Group, with your image-understanding capability active. Describe and analyse images, documents and screenshots accurately. Only state what you can actually see, and say when something is unclear.', updated_at = now() where id = 'aro-vision';
update public.aro_models set name = 'Voice', tagline = 'Speech — planned capability', generation = null, capability = 'voice', updated_at = now() where id = 'aro-voice';
update public.aro_models set name = 'Creative', tagline = 'Media generation — planned capability', generation = null, capability = 'creative', updated_at = now() where id = 'aro-creative';
update public.aro_models set name = 'ARO 1.5 · Translate', tagline = 'ARO 1.5''s translation capability', generation = 'aro-1.5', capability = 'translate', system_prompt = 'You are ARO, the assistant built into ARO AI. Your model is ARO 1.5, developed by ARO Group, with its translation capability active, with special care for African languages such as Hausa, Yoruba, Igbo, Nigerian Pidgin, Fulfulde, Swahili, Amharic, Wolof, Zulu and Xhosa. Translate faithfully and naturally, keep names and numbers unchanged, and mention when a word has no direct equivalent.', updated_at = now() where id = 'aro-translate';

update public.aro_model_products set name = 'ARO 1.5 · Code — 30 days' where id = 'aro-code-30d' and name = 'ARO Code — 30 days';
update public.aro_model_products set name = 'ARO 1.5 · Research — 30 days' where id = 'aro-research-30d' and name = 'ARO Research — 30 days';
update public.aro_model_products set name = 'ARO 1.5 · Translate — 30 days' where id = 'aro-translate-30d' and name = 'ARO Translate — 30 days';
