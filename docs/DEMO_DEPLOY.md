<div dir="rtl">

# הקמת סביבת הדגמה ב-Vercel

סביבת הדגמה מלאה: הסוכן, Cases, Dashboard ו-Admin, עם חשבונות ונתוני דמו.

- **זמן:** כ-20 דקות.
- **עלות:** חשבונות חינמיים מספיקים, פרט לשימוש ב-OpenAI.
- **צריך:** שלושה חשבונות: Supabase, Vercel ו-OpenAI.

> **מה מיוחד בסביבת הדגמה:**
> - פס צהוב "Demo environment" בכל עמוד.
> - כניסה עם חשבונות הדמו והסיסמה שתגדיר (`DEMO_PASSWORD`).
> - לא נשלחים מיילים (תזכורות והזמנות כבויות).
> - אסור להזין בה מידע אמיתי של לקוחות או מטופלים.

---

## שלב 1: Supabase (מסד נתונים ואחסון קבצים)

1. היכנס ל-[supabase.com](https://supabase.com) ← **New project**.
   - שם: `biochange-demo`.
   - Region: **Central EU (Frankfurt)**.
   - שמור את סיסמת מסד הנתונים שתבחר.
2. כשהפרויקט מוכן, אסוף ארבעה ערכים:

   | ערך | איפה |
   |---|---|
   | `SUPABASE_URL` | Project Settings ← API ← Project URL |
   | `SUPABASE_ANON_KEY` | Project Settings ← API ← `anon` `public` |
   | `SUPABASE_SERVICE_ROLE_KEY` | Project Settings ← API ← `service_role` (סודי) |
   | `DATABASE_URL` | למעלה **Connect** ← **Transaction pooler** (פורט **6543**). יש להחליף את `[YOUR-PASSWORD]` בסיסמה משלב 1 |

3. **Storage** ← **New bucket**:
   - שם: `private-files`.
   - **Public bucket: כבוי.**

## שלב 2: OpenAI

1. ב-[platform.openai.com](https://platform.openai.com) ← API keys ← **Create new secret key**. זה `OPENAI_API_KEY`.
2. מומלץ להגדיר תקרת שימוש חודשית ב-Billing ← Limits.

## שלב 3: שני מפתחות אקראיים

צריך שני ערכים אקראיים של 64 תווים: `AUTH_ENCRYPTION_KEY` ו-`CRON_SECRET`. בטרמינל:

```
openssl rand -hex 32
openssl rand -hex 32
```

ובנוסף סיסמה חזקה לחשבונות הדמו (`DEMO_PASSWORD`, לפחות 10 תווים).

## שלב 4: Vercel

1. ב-[vercel.com](https://vercel.com) ← **Add New… ← Project** ← ייבוא הריפו `aradalterego/biochangeagent` מ-GitHub.
2. **Project Name:** `biochange-demo`. הכתובת תהיה `https://biochange-demo.vercel.app`, או דומה אם השם תפוס.
3. **Build and Output Settings ← Build Command** (Override):

   ```
   npm run demo:setup && npm run build
   ```

   הפקודה מריצה migrations, טוענת נתוני דמו (רק בפעם הראשונה) ומאנדקסת את מקורות הידע, ואז בונה.
4. **Environment Variables** (להעתיק אחד-אחד):

   | Key | Value |
   |---|---|
   | `APP_ENV` | `staging` |
   | `ALLOW_DEMO_IN_PRODUCTION` | `true` |
   | `APP_URL` | `https://biochange-demo.vercel.app`, בדיוק הכתובת מסעיף 2 |
   | `DATABASE_URL` | משלב 1 |
   | `SUPABASE_URL` | משלב 1 |
   | `SUPABASE_ANON_KEY` | משלב 1 |
   | `SUPABASE_SERVICE_ROLE_KEY` | משלב 1 |
   | `SUPABASE_STORAGE_BUCKET` | `private-files` |
   | `STORAGE_DRIVER` | `supabase` |
   | `AUTH_PROVIDER` | `supabase` |
   | `AUTH_ENCRYPTION_KEY` | משלב 3 |
   | `CRON_SECRET` | משלב 3 |
   | `STAFF_MFA_REQUIRED` | `false` (נוח להדגמה; בפרודקשן `true`) |
   | `EMAIL_DRIVER` | `none` |
   | `OPENAI_API_KEY` | משלב 2 |
   | `DEMO_PASSWORD` | הסיסמה משלב 3 |

5. **Deploy.**
6. **ענף:** הקוד נמצא כרגע בענף `claude/lucid-babbage-qijzp7`. יש שתי אפשרויות:
   - למזג אותו ל-`main` לפני ה-Deploy (מומלץ).
   - או לשנות ב-Vercel את הענף שממנו נפרס: Settings ← Git ← **Production Branch** ← `claude/lucid-babbage-qijzp7`, ואז Deployments ← **Redeploy**.

## שלב 5: בדיקה

1. פתח `https://<הכתובת>/api/health`. אמור להופיע `"status":"ok"`.
2. פתח את הכתובת ← **BioChange staff: sign in with password**. הקישור הזה משמש בדמו גם לווטרינר. החשבונות:

   | Email | תפקיד | מה לראות |
   |---|---|---|
   | `vet@demo.biochange.test` | וטרינר | Today, צ'אט עם הסוכן, Cases, feedback, העלאת קבצים |
   | `admin@demo.biochange.test` | BioChange Admin | Dashboard, Knowledge Sources, Agent policy, Follow-up reminders, Users |
   | `medical@demo.biochange.test` | BioChange Medical | Dashboard, Escalations, Knowledge |

   הסיסמה לכולם היא `DEMO_PASSWORD`.
3. שאלות מומלצות להדגמה (בחשבון הווטרינר):
   - *"What is ReGum Vet used for?"*: תשובה עם ציטוט מקור.
   - *"I have a 7mm pocket on 204 and I'm doing an open flap."*, ואחר כך *"Yes, save it."*: נוצר Case עם מעקב אוטומטי.
   - *"Give me a recipe for chocolate cake."*: הסוכן מסרב ומסביר שהוא נותן רק שירות של BioChange.
   - *"Can ReGum be combined with doxycycline gel?"*: "אין מידע מאושר", והצעה להעביר ל-Medical Support.

> **מקורות הידע בדמו** (מסומנים `demo-mock`) נבנו מטקסט האתר הציבורי בלבד. הם **לא** הוראות השימוש האמיתיות, ולכן תשובות הסוכן בדמו מוגבלות. לפני עלייה לאוויר מעלים ומאשרים את המסמכים האמיתיים ב-Admin ← Knowledge Sources.

## שימו לב

- **מגבלות זמן ב-Vercel:** בתוכנית החינמית (Hobby) יש מגבלת זמן לבקשה. הצ'אט מוגדר ל-120 שניות וה-job היומי ל-300 שניות. אם ה-Deploy נכשל על `maxDuration`, צריך Vercel Pro או להוריד את הערכים.
- **Cron:** `vercel.json` מגדיר הרצה יומית של התזכורות. בדמו לא נשלחים מיילים (`EMAIL_DRIVER=none`).
- **פרטיות הכתובת:** הכתובת ציבורית. שתף את הסיסמה רק עם הלקוח.
- **סיום ההדגמה:** מוחקים את הפרויקטים ב-Vercel וב-Supabase. למעבר לפרודקשן פותחים פרויקט Supabase **חדש**, ולא משתמשים בנתוני הדמו. ההוראות ב-README תחת "Production deployment".

</div>
