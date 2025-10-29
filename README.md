
# ClosetShare v3.8 (Full Ready: Terms + PWA + Admin)

- レンタル/販売ハイブリッド + Stripe Connect自動送金
- 規約ページ（/terms.html）
- PWA（/manifest.json, /service-worker.js, アイコン）
- 管理UI（/admin.html）: 監査ログ・最近の予約/購入・簡易検索

## 環境変数
ADMIN_KEY, SECOND_ADMIN_KEY, JWT_SECRET, PUBLIC_BASE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, PLATFORM_FEE_BPS

## Webhook
POST /webhooks/stripe （イベント: checkout.session.completed）

## 管理エンドポイント（x-admin-key ヘッダ必須）
GET /api/audit
GET /api/admin/bookings
GET /api/admin/orders
GET /api/admin/search?q=キーワード
