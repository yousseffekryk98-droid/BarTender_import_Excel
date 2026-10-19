import React, { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';

/** Classic desktop menu bar. menus: [{ id, label, items: [{ label, shortcut, onClick, disabled, checked } | '-'] }] */
export default function MenuBar({ menus }) {
  const [open, setOpen] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!ref.current?.contains(e.target)) setOpen(null); };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(null);
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const i = menus.findIndex((m) => m.id === open);
        setOpen(menus[(i + (e.key === 'ArrowRight' ? 1 : menus.length - 1)) % menus.length].id);
      }
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open, menus]);
  return <nav className="menubar" ref={ref} role="menubar" aria-label="Application menu">
    {menus.map((menu) => <div key={menu.id} className={'menu' + (open === menu.id ? ' open' : '')}>
      <button type="button" role="menuitem" aria-haspopup="true" aria-expanded={open === menu.id} data-testid={'menu-' + menu.id}
        onClick={() => setOpen(open === menu.id ? null : menu.id)} onMouseEnter={() => { if (open && open !== menu.id) setOpen(menu.id); }}>{menu.label}</button>
      {open === menu.id && <div className="menu-pop" role="menu">
        {menu.items.map((item, i) => (item === '-' ? <div key={'s' + i} className="menu-sep" role="separator" /> :
          <button key={item.label} type="button" role="menuitem" className="menu-item" disabled={item.disabled} data-testid={'menuitem-' + item.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}
            onClick={() => { setOpen(null); item.onClick(); }}>
            <span className="mi-check">{item.checked ? <Check size={13} /> : null}</span>
            <span className="mi-label">{item.label}</span>
            <span className="mi-shortcut">{item.shortcut || ''}</span>
          </button>))}
      </div>}
    </div>)}
  </nav>;
}
