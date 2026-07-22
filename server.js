require('dotenv').config();
const express = require('express');
const cors = require('cors');
const midtransClient = require('midtrans-client');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ORDERS_FILE = path.join(__dirname, 'orders.json');
if (!fs.existsSync(ORDERS_FILE)) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify([], null, 2));
}

function readOrders() {
  return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf-8'));
}

function saveOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

const snap = new midtransClient.Snap({
  isProduction: process.env.IS_PRODUCTION === 'true',
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY
});

const RAJAONGKIR_API_KEY = process.env.RAJAONGKIR_API_KEY;
const RAJAONGKIR_ORIGIN_ID = process.env.RAJAONGKIR_ORIGIN_ID; // ID subdistrict/kota asal (Tangerang)
const RAJAONGKIR_BASE = 'https://rajaongkir.komerce.id/api/v1';

// Kirim client key ke frontend supaya popup Snap bisa dimuat
app.get('/api/config', (req, res) => {
  res.json({ clientKey: process.env.MIDTRANS_CLIENT_KEY });
});

// Cari kota/kecamatan tujuan (buat autocomplete alamat di frontend)
app.get('/api/search-destination', async (req, res) => {
  try {
    const keyword = req.query.keyword;
    if (!keyword || keyword.length < 3) {
      return res.json({ data: [] });
    }
    const url = `${RAJAONGKIR_BASE}/destination/domestic-destination?search=${encodeURIComponent(keyword)}&limit=10&offset=0`;
    const response = await fetch(url, {
      headers: { key: RAJAONGKIR_API_KEY }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal mencari kota tujuan.' });
  }
});

// Hitung ongkir berdasarkan tujuan & berat total keranjang
app.post('/api/cek-ongkir', async (req, res) => {
  try {
    const { destination_id, weight } = req.body;
    if (!destination_id || !weight) {
      return res.status(400).json({ error: 'Tujuan atau berat belum lengkap.' });
    }

    const params = new URLSearchParams();
    params.append('origin', RAJAONGKIR_ORIGIN_ID);
    params.append('destination', destination_id);
    params.append('weight', weight);
    params.append('courier', 'jne:jnt:sicepat');

    const response = await fetch(`${RAJAONGKIR_BASE}/calculate/domestic-cost`, {
      method: 'POST',
      headers: {
        key: RAJAONGKIR_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal menghitung ongkir.' });
  }
});

// Buat transaksi baru -> hasilkan token pembayaran Snap
app.post('/api/create-transaction', async (req, res) => {
  try {
    const { items, customer, shipping } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'Keranjang kosong.' });
    }
    if (!customer || !customer.name || !customer.phone || !customer.address) {
      return res.status(400).json({ error: 'Data pelanggan belum lengkap.' });
    }

    const itemsAmount = items.reduce((sum, it) => sum + it.price * it.qty, 0);
    const shippingCost = shipping && shipping.cost ? shipping.cost : 0;
    const grossAmount = itemsAmount + shippingCost;
    const orderId = 'SL-' + Date.now();

    const itemDetails = items.map(it => ({
      id: String(it.id),
      price: it.price,
      quantity: it.qty,
      name: it.name.substring(0, 50)
    }));

    if (shippingCost > 0) {
      itemDetails.push({
        id: 'ongkir',
        price: shippingCost,
        quantity: 1,
        name: `Ongkir (${shipping.courier || ''} ${shipping.service || ''})`.substring(0, 50)
      });
    }

    const parameter = {
      transaction_details: {
        order_id: orderId,
        gross_amount: grossAmount
      },
      item_details: itemDetails,
      customer_details: {
        first_name: customer.name,
        phone: customer.phone,
        shipping_address: {
          address: customer.address
        }
      }
    };

    const transaction = await snap.createTransaction(parameter);

    const orders = readOrders();
    orders.push({
      order_id: orderId,
      customer,
      items,
      shipping: shipping || null,
      items_amount: itemsAmount,
      shipping_cost: shippingCost,
      gross_amount: grossAmount,
      status: 'pending',
      created_at: new Date().toISOString()
    });
    saveOrders(orders);

    res.json({ token: transaction.token, order_id: orderId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal membuat transaksi. Coba lagi.' });
  }
});

// Webhook: Midtrans akan memanggil URL ini otomatis setiap status pembayaran berubah
app.post('/api/midtrans-notification', async (req, res) => {
  try {
    const statusResponse = await snap.transaction.notification(req.body);
    const orderId = statusResponse.order_id;
    const transactionStatus = statusResponse.transaction_status;
    const fraudStatus = statusResponse.fraud_status;

    let newStatus = 'pending';
    if (transactionStatus === 'capture' || transactionStatus === 'settlement') {
      newStatus = (fraudStatus === 'accept' || !fraudStatus) ? 'paid' : 'challenge';
    } else if (transactionStatus === 'cancel' || transactionStatus === 'deny' || transactionStatus === 'expire') {
      newStatus = 'failed';
    } else if (transactionStatus === 'pending') {
      newStatus = 'pending';
    }

    const orders = readOrders();
    const idx = orders.findIndex(o => o.order_id === orderId);
    if (idx !== -1) {
      orders[idx].status = newStatus;
      orders[idx].updated_at = new Date().toISOString();
      saveOrders(orders);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
});

// Lihat semua pesanan (dasar untuk admin sederhana)
app.get('/api/orders', (req, res) => {
  res.json(readOrders());
});

// Cek status satu pesanan (dipakai frontend setelah pembayaran)
app.get('/api/orders/:orderId', (req, res) => {
  const orders = readOrders();
  const order = orders.find(o => o.order_id === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
  res.json(order);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server jalan di http://localhost:${PORT}`);
});
