// Fonte da verdade dos kits. O browser manda SÓ o id do kit;
// valor e descrição saem daqui. Nunca confie no amount vindo do cliente.
export const KITS = {
  kit5: {
    nome: 'Kit 5 Panelas + Brinde 7 Colheres',
    resumo: 'Pressão 5L + Caçarola 3L + Caçarola 2L + Caçarola 1L + Frigideira + brinde 7 colheres',
    amount: 21990, // R$ 219,90
  },
  kit3: {
    nome: 'Kit 3 Panelas',
    resumo: 'Pressão 5L + Caçarola 3L + Frigideira',
    amount: 16790, // R$ 167,90
  },
  kit2: {
    nome: 'Kit 2 Panelas',
    resumo: 'Pressão 5L + Caçarola 3L',
    amount: 12790, // R$ 127,90
  },
  kit1: {
    nome: '1 Panela',
    resumo: 'Caçarola 3L em pedra sabão maciça',
    amount: 7990, // R$ 79,90
  },
};

export function getKit(id) {
  return Object.prototype.hasOwnProperty.call(KITS, id) ? { id, ...KITS[id] } : null;
}

export function formatBRL(cents) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
