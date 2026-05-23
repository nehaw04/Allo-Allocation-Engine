'use client';

import { useState, useEffect } from 'react';

interface ProductInventory {
  product_id: string;
  sku: string;
  name: string;
  description: string;
  price: number;
  warehouse_id: string;
  warehouse_name: string;
  location: string;
  totalUnits: number;
}

export default function FulfillmentDashboard() {
  // Application State Hub
  const [catalog, setCatalog] = useState<ProductInventory[]>([]);
  const [loading, setLoading] = useState(true);
  const [reservation, setReservation] = useState<{
    id: string;
    productId: string;
    warehouseId: string;
    sku: string;
    name: string;
    warehouseName: string;
    quantity: number;
    price: number;
    expiresAt: string;
  } | null>(null);

  const [timeLeft, setTimeLeft] = useState<number>(0);
  
  // High-Contrast Error/Notification Banners
  const [systemError, setSystemError] = useState<{ type: '409' | '410' | '500' | 'SUCCESS'; message: string } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // 1. Fetch live product registry matrix from direct cloud tables
  async function fetchCatalog() {
    try {
      const res = await fetch('/api/products');
      const data = await res.json();
      if (data.success) {
        setCatalog(data.catalog);
      }
    } catch (err) {
      setSystemError({ type: '500', message: 'CRITICAL: Lost streaming link to distributed cloud database.' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchCatalog();
  }, []);

  // 2. Automated Countdown Clock & Lazy Expiry Handler
  useEffect(() => {
    if (!reservation) return;

    const interval = setInterval(() => {
      const diff = Math.max(0, Math.floor((new Date(reservation.expiresAt).getTime() - Date.now()) / 1000));
      setTimeLeft(diff);
      
      // Handle 410 Expired Hold State instantly on front-end when timer hits absolute zero
      if (diff === 0) {
        setReservation(null);
        setSystemError({ 
          type: '410', 
          message: `STATUS 410 (GONE): Reservation ${reservation.id.slice(0,8)} has expired. Inventory blocks reallocated back to regional pools.` 
        });
        fetchCatalog();
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [reservation]);

  // 3. API Action: POST - Acquire Pessimistic Hold Lock
  async function acquireInventoryHold(item: ProductInventory) {
    setSystemError(null);
    setActionLoading(true);
    
    try {
      const res = await fetch('/api/reservations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          productId: item.product_id, 
          warehouseId: item.warehouse_id, 
          quantity: 1 
        })
      });

      const data = await res.json();

      if (res.status === 201 && data.success) {
        setReservation({
          id: data.reservationId,
          productId: item.product_id,
          warehouseId: item.warehouse_id,
          sku: item.sku,
          name: item.name,
          warehouseName: item.warehouse_name,
          quantity: 1,
          price: item.price,
          expiresAt: data.expiresAt
        });
        setSystemError({ type: 'SUCCESS', message: 'MIGRATION SUCCESS: Safe database row lock verified. Window holding.' });
        fetchCatalog();
      } else if (res.status === 409) {
        // Explictly catch and bubble up high-concurrency race condition faults
        setSystemError({ 
          type: '409', 
          message: `CONFLICT 409 (OUT OF STOCK): Synchronization race detected. Target allocation units exhausted by parallel workers.` 
        });
        fetchCatalog();
      } else {
        setSystemError({ type: '500', message: data.error || 'Unknown deployment processing fault.' });
      }
    } catch (err) {
      setSystemError({ type: '500', message: 'Network communication timeout executing pipeline transaction.' });
    } finally {
      setActionLoading(false);
    }
  }

  // 4. API Action: PATCH - Finalize Checkout Payment & Commit Decrement
  async function executeCheckout() {
    if (!reservation) return;
    setSystemError(null);
    setActionLoading(true);

    try {
      const res = await fetch(`/api/reservations/${reservation.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservationId: reservation.id })
      });

      const data = await res.json();

      if (res.status === 200 && data.success) {
        setSystemError({ type: 'SUCCESS', message: 'TRANSACTION COMMITTED: Physical stock decremented safely. Ledger clean.' });
        setReservation(null);
        fetchCatalog();
      } else if (res.status === 410) {
        setSystemError({ 
          type: '410', 
          message: 'MUTATION FAILED (410 GONE): Hold window lapsed mid-flight. Stock reclaimed by parallel worker threads.' 
        });
        setReservation(null);
        fetchCatalog();
      } else {
        setSystemError({ type: '500', message: data.error || 'Failed to complete transaction sequence.' });
      }
    } catch (err) {
      setSystemError({ type: '500', message: 'Network exception during payment checkout processing.' });
    } finally {
      setActionLoading(false);
    }
  }

  // 5. API Action: Cancel Reservation Hold Window Manually
  async function manualCancelReservation() {
  if (!reservation) return;
  try {
    await fetch(`/api/reservations/${reservation.id}/release`, { method: 'POST' });
  } catch (err) {
    console.error(err);
  }
  setReservation(null);
  setSystemError({ type: 'SUCCESS', message: 'User aborted reservation hold window. Units released immediately.' });
  fetchCatalog();
  }
   

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 p-6 sm:p-10 font-sans selection:bg-indigo-500/30">
      <div className="max-w-6xl mx-auto">
        
        {/* Navigation Core Infrastructure Banner */}
        <header className="mb-10 border-b border-neutral-800 pb-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-white uppercase">Allo Allocation Hub</h1>
              <span className="text-[10px] font-mono tracking-widest px-2 py-0.5 bg-neutral-800 text-neutral-400 border border-neutral-700 rounded">V2.1</span>
            </div>
            <p className="text-neutral-400 text-xs sm:text-sm mt-1">High-Concurrency Distributed Inventory Engine • Live Node Processing</p>
          </div>
          <div className="flex items-center gap-2.5 bg-neutral-900 px-4 py-2 rounded-lg border border-neutral-800 shadow-inner">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs font-mono font-bold uppercase tracking-wider text-neutral-300">Neon Cloud Active</span>
          </div>
        </header>

        {/* SYSTEM STATUS FEEDBACK (Handles explicit 409, 410, and Success messaging blocks) */}
        {systemError && (
          <div className={`mb-8 p-4 rounded-xl border font-mono text-xs sm:text-sm shadow-xl flex items-start gap-3 animate-fadeIn ${
            systemError.type === '409' ? 'bg-amber-950/40 border-amber-500/50 text-amber-300' :
            systemError.type === '410' ? 'bg-rose-950/40 border-rose-500/50 text-rose-300' :
            systemError.type === 'SUCCESS' ? 'bg-emerald-950/40 border-emerald-500/50 text-emerald-300' :
            'bg-red-950/40 border-red-500/50 text-red-300'
          }`}>
            <span className="font-black mt-0.5">
              {systemError.type === '409' || systemError.type === '410' ? '⚠️' : 'ℹ️'}
            </span>
            <div className="flex-1">
              <span className="font-bold uppercase block text-[10px] tracking-widest opacity-60 mb-0.5">Engine Notice</span>
              {systemError.message}
            </div>
          </div>
        )}

        {/* RESERVATION / CHECKOUT TIER PAGE PANEL */}
        {reservation ? (
          <section className="mb-12 p-6 sm:p-8 rounded-2xl bg-gradient-to-br from-neutral-900 to-neutral-900 border-2 border-indigo-500/40 shadow-2xl animate-slideDown">
            <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-8">
              <div className="space-y-3 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono px-2 py-0.5 bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 rounded font-bold uppercase tracking-wider">Holding Transaction</span>
                  <span className="text-xs font-mono text-neutral-500">Lock ID: {reservation.id}</span>
                </div>
                <h2 className="text-2xl font-black text-white">{reservation.name}</h2>
                <p className="text-xs text-neutral-400 font-mono">
                  Allocated Location Container: <span className="text-neutral-200">{reservation.warehouseName}</span>
                </p>
                <div className="text-sm font-semibold text-neutral-300">
                  Transaction Units Matrix: <span className="font-mono text-emerald-400 font-bold">{reservation.quantity} Unit</span> • Total: <span className="font-mono text-white">₹{reservation.price.toLocaleString('en-IN')}</span>
                </div>
              </div>

              {/* Real-time Countdown Frame */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-6 w-full lg:w-auto border-t lg:border-t-0 border-neutral-800 pt-6 lg:pt-0">
                <div className="bg-neutral-950/80 px-6 py-3 rounded-xl border border-neutral-800 text-center sm:text-left min-w-[140px]">
                  <span className="text-[10px] block text-neutral-500 uppercase tracking-widest font-bold">Lock Lifespan</span>
                  <span className={`text-3xl font-mono font-black tracking-wider ${timeLeft < 60 ? 'text-rose-400 animate-pulse' : 'text-amber-400'}`}>
                    {formatTime(timeLeft)}
                  </span>
                </div>
                
                <div className="flex flex-col sm:flex-row gap-3 flex-1 sm:flex-initial">
                  <button 
                    disabled={actionLoading}
                    onClick={executeCheckout}
                    className="bg-emerald-500 hover:bg-emerald-400 disabled:bg-neutral-800 disabled:text-neutral-500 text-neutral-950 text-sm font-black tracking-wide px-6 py-3.5 rounded-xl transition duration-150 transform active:scale-95 shadow-lg shadow-emerald-500/10 uppercase"
                  >
                    {actionLoading ? 'Committing...' : 'Confirm Purchase'}
                  </button>
                  <button 
                    disabled={actionLoading}
                    onClick={manualCancelReservation}
                    className="bg-neutral-800 hover:bg-neutral-700 disabled:text-neutral-600 text-neutral-300 text-sm font-bold px-5 py-3.5 rounded-xl transition duration-150 active:scale-95 border border-neutral-700 uppercase tracking-wide"
                  >
                    Cancel Hold
                  </button>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {/* REGIONAL STOCK ALLOCATION PRODUCT LISTING MATRIX */}
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-lg font-bold uppercase tracking-wider text-neutral-200">Regional Distribution Ledger</h2>
          {!reservation && <p className="text-neutral-500 text-xs font-mono">Select single unit target allocation hold</p>}
        </div>

        {loading ? (
          <div className="text-center py-20 font-mono text-neutral-500 tracking-widest uppercase animate-pulse">
            Querying active distributed inventory shards...
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {catalog.map((item, index) => {
              const isOutOfStock = item.totalUnits === 0;
              return (
                <div 
                  key={index} 
                  className={`bg-neutral-900 border rounded-2xl p-6 shadow-xl transition-all duration-200 flex flex-col justify-between ${
                    reservation ? 'opacity-40 border-neutral-800' : 'hover:border-neutral-700 border-neutral-800/80'
                  }`}
                >
                  <div>
                    <div className="flex justify-between items-start gap-4 mb-3">
                      <div>
                        <span className="text-[10px] font-mono px-2 py-0.5 bg-neutral-800 text-neutral-400 border border-neutral-700 rounded font-bold uppercase tracking-wider">
                          {item.sku}
                        </span>
                        <h3 className="text-xl font-black tracking-tight text-white mt-1.5">{item.name}</h3>
                      </div>
                      <span className="text-lg font-mono font-black text-emerald-400 bg-emerald-500/5 px-2.5 py-1 rounded-lg border border-emerald-500/10">
                        ₹{item.price.toLocaleString('en-IN')}
                      </span>
                    </div>
                    
                    <p className="text-neutral-400 text-xs sm:text-sm line-clamp-2 mb-6">{item.description}</p>
                    
                    {/* Warehouse Data Metrics Card */}
                    <div className="bg-neutral-950/60 rounded-xl p-4 border border-neutral-800 font-mono text-xs mb-6 space-y-2.5 shadow-inner">
                      <div className="flex justify-between items-center text-neutral-400">
                        <span>Node Hub Location:</span>
                        <span className="text-neutral-200 text-right font-medium">{item.warehouse_name} ({item.location})</span>
                      </div>
                      <div className="flex justify-between items-center border-t border-neutral-800/60 pt-2.5">
                        <span className="text-neutral-400">Stock Availability Pool:</span>
                        <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                          isOutOfStock ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' : 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                        }`}>
                          {item.totalUnits} Balanced Units
                        </span>
                      </div>
                    </div>
                  </div>

                  <button
                    disabled={isOutOfStock || !!reservation || actionLoading}
                    onClick={() => acquireInventoryHold(item)}
                    className={`w-full font-black py-3.5 rounded-xl text-xs uppercase tracking-widest transition duration-150 transform active:scale-[0.99] ${
                      isOutOfStock 
                        ? 'bg-neutral-800 text-neutral-600 cursor-not-allowed border border-neutral-700/30'
                        : !!reservation
                          ? 'bg-neutral-900 text-neutral-600 border border-neutral-800/80 cursor-not-allowed'
                          : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/10 hover:shadow-indigo-500/20'
                    }`}
                  >
                    {isOutOfStock ? 'Units Depleted' : !!reservation ? 'Clear Running Hold' : 'Reserve Allocation Hold'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}