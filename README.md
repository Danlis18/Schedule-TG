# LevelUp Life — Telegram Mini App

Мотиваційний Telegram Mini App у форматі «гра на життя»: щоденні квести, зірки, дохід, скарбничка бажань, серії та статистика. Тестових акаунтів і демонстраційних даних немає.

## Локальний запуск

Потрібні Node.js 20+ і PostgreSQL. Скопіюйте `.env.example` у `.env`, вкажіть локальний `DATABASE_URL`, після чого виконайте `npm install` та `npm start`.

## Railway

Створіть сервіс із GitHub-репозиторію та додайте Variables:

- `APP_SECRET` — довгий випадковий секрет;
- `TELEGRAM_BOT_TOKEN` — токен від BotFather;
- `DATABASE_URL` — Railway додасть автоматично після підключення PostgreSQL;
- `NODE_ENV=production`;
- `PGSSL=false` для внутрішнього Railway PostgreSQL;
- `PORT` Railway встановлює автоматично.

Після деплою URL потрібно вказати у BotFather через `/newapp` або налаштування Menu Button. `TELEGRAM_BOT_TOKEN` використовується для перевірки `initData` Telegram на сервері.

## Дані та безпека

Усі акаунти, квести, доходи, бажання й покупки зберігаються в PostgreSQL. Паролі зберігаються як salted scrypt-хеші. Баланси зірок і скарбнички змінюються в транзакціях, а Telegram `initData` перевіряється сервером.
