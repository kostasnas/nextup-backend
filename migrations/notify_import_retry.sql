-- Sends the person behind an import job an in-app notification that they can try importing again
-- (after the problem was fixed). Language: their chosen app language, else their device language at
-- sign-up, else English. Usage (first 8+ characters of the job id from the "Import issue" push):
--   select * from notify_import_retry('abcdef12');
create or replace function notify_import_retry(job_prefix text)
returns table (notified_user uuid, lang text, notice text)
language plpgsql as $$
declare
  j record;
  l text;
  pair jsonb;
  msgs jsonb := '{
    "en": ["You can import again", "We fixed the problem with your import. You can try it again now. Thanks for your patience!"],
    "es": ["Ya puedes volver a importar", "Solucionamos el problema con tu importación. Ya puedes intentarlo de nuevo. ¡Gracias por tu paciencia!"],
    "pt": ["Você já pode importar de novo", "Corrigimos o problema com a sua importação. Pode tentar de novo agora. Obrigado pela paciência!"],
    "de": ["Du kannst wieder importieren", "Wir haben das Problem mit deinem Import behoben. Du kannst es jetzt erneut versuchen. Danke für deine Geduld!"],
    "fr": ["Vous pouvez réimporter", "Nous avons corrigé le problème avec votre import. Vous pouvez réessayer maintenant. Merci de votre patience !"],
    "ar": ["يمكنك الاستيراد مجددًا", "أصلحنا المشكلة في الاستيراد الخاص بك. يمكنك المحاولة مرة أخرى الآن. شكرًا على صبرك!"],
    "tr": ["Tekrar içe aktarabilirsin", "İçe aktarmanla ilgili sorunu düzelttik. Şimdi tekrar deneyebilirsin. Sabrın için teşekkürler!"],
    "it": ["Puoi importare di nuovo", "Abbiamo risolto il problema con la tua importazione. Ora puoi riprovare. Grazie per la pazienza!"],
    "id": ["Kamu bisa mengimpor lagi", "Kami sudah memperbaiki masalah pada impormu. Silakan coba lagi sekarang. Terima kasih atas kesabarannya!"],
    "hi": ["आप फिर से इम्पोर्ट कर सकते हैं", "हमने आपके इम्पोर्ट की समस्या ठीक कर दी है। अब आप दोबारा कोशिश कर सकते हैं। धैर्य रखने के लिए धन्यवाद!"],
    "ru": ["Можно импортировать снова", "Мы исправили проблему с вашим импортом. Теперь можно попробовать ещё раз. Спасибо за терпение!"]
  }'::jsonb;
begin
  select ij.id as job_id, ij.user_id as uid, u.raw_user_meta_data as meta
    into j
    from import_jobs ij join auth.users u on u.id = ij.user_id
   where ij.id::text like job_prefix || '%'
   order by ij.created_at desc limit 1;
  if j.job_id is null then raise exception 'No import job starts with %', job_prefix; end if;
  l := lower(coalesce(nullif(j.meta->>'language', ''), left(j.meta->'acquisition'->>'locale', 2), 'en'));
  if not (msgs ? l) then l := 'en'; end if;
  pair := msgs -> l;
  insert into notifications (user_id, type, title, body, data)
  values (j.uid, 'announcement', pair->>0, pair->>1, jsonb_build_object('kind', 'import_retry', 'job', j.job_id));
  return query select j.uid, l, (pair->>0)::text;
end $$;
