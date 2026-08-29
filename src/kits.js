// Fonte da verdade dos kits. O browser manda SÓ o id do kit;
// valor, desconto e descrição saem daqui. Nunca confie no amount do cliente.
// Valores em centavos. `de` = preço "cheio" riscado (mesma oferta da landing page).
export const KITS = {
  kit5: {
    nome: 'Kit 5 Panelas + Brinde 7 Colheres',
    resumo: 'Pressão 5L · Caçarola 3L · Caçarola 2L · Caçarola 1L · Frigideira · brinde: 7 colheres de pau e pedra sabão',
    amount: 21990,
    de: 39990,
    unidades: 5,
    emoji: '🍲',
    destaque: true,
    selo: 'MAIS VANTAJOSO',
  },
  kit3: {
    nome: 'Kit 3 Panelas',
    resumo: 'Panela de pressão 5L · Caçarola 3L · Frigideira',
    amount: 16790,
    de: 23990,
    unidades: 3,
    emoji: '🥘',
  },
  kit2: {
    nome: 'Kit 2 Panelas',
    resumo: 'Panela de pressão 5L · Caçarola 3L',
    amount: 12790,
    de: 15990,
    unidades: 2,
    emoji: '🍜',
  },
  kit1: {
    nome: '1 Panela de Pedra Sabão',
    resumo: 'Caçarola 3L em pedra sabão maciça, com alça de cobre',
    amount: 7990,
    unidades: 1,
    emoji: '🫕',
  },
};

// Prazo de entrega mostrado no checkout (dias úteis).
export const ENTREGA = '3 a 7 dias úteis';

export function getKit(id) {
  return Object.prototype.hasOwnProperty.call(KITS, id) ? { id, ...KITS[id] } : null;
}

export function formatBRL(cents) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Objeto público que a página de checkout consome (sem nada sensível).
export function kitView(kit) {
  const hasDesc = Number.isInteger(kit.de) && kit.de > kit.amount;
  return {
    id: kit.id,
    nome: kit.nome,
    resumo: kit.resumo,
    emoji: kit.emoji || '🛒',
    img: `/assets/kits/${kit.id}.webp`,
    unidades: kit.unidades || 1,
    selo: kit.selo || null,
    destaque: !!kit.destaque,
    amount: kit.amount,
    amount_brl: formatBRL(kit.amount),
    de_brl: hasDesc ? formatBRL(kit.de) : null,
    desconto_pct: hasDesc ? Math.round((1 - kit.amount / kit.de) * 100) : null,
    economia_brl: hasDesc ? formatBRL(kit.de - kit.amount) : null,
    por_unidade_brl: kit.unidades > 1 ? formatBRL(Math.round(kit.amount / kit.unidades)) : null,
    entrega: ENTREGA,
  };
}
