-- ARO 1.5 Code and Translate have no published LoRA adapter on the model
-- server yet (only aro-research is loaded), so requests for "aro-code" /
-- "aro-translate" failed. Serve them with the ARO 1.5 base model — each keeps
-- its own capability system prompt — until their adapters are trained,
-- evaluated and added to the server's --lora-modules; then set served_name back.
update public.aro_models set served_name = 'aro-1.5', updated_at = now()
 where id in ('aro-code', 'aro-translate');
