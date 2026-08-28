export function onlyDigits(s) {
  return String(s ?? '').replace(/\D/g, '');
}

export function cleanStr(s, max) {
  return String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

export function isValidEmail(s) {
  return typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// CPF com dígitos verificadores (rejeita 000... e sequências repetidas)
export function isValidCPF(raw) {
  const cpf = onlyDigits(raw);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const digit = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const mod = (sum * 10) % 11;
    return mod === 10 ? 0 : mod;
  };
  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10]);
}

export function isValidPhone(raw) {
  const p = onlyDigits(raw);
  return p.length === 10 || p.length === 11;
}

export function isValidCEP(raw) {
  return onlyDigits(raw).length === 8;
}

const UF = new Set([
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG',
  'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
]);
export function isValidUF(s) {
  return UF.has(String(s ?? '').toUpperCase());
}

// Valida o payload do checkout. Retorna { ok, value, errors }.
export function validateCheckout(body, kit) {
  const b = body ?? {};
  const value = {
    kit: kit.id,
    amount: kit.amount,
    name: cleanStr(b.name, 120),
    email: cleanStr(b.email, 254).toLowerCase(),
    cpf: onlyDigits(b.cpf),
    phone: onlyDigits(b.phone),
    cep: onlyDigits(b.cep),
    street: cleanStr(b.street, 160),
    number: cleanStr(b.number, 20),
    complement: cleanStr(b.complement, 80),
    district: cleanStr(b.district, 120),
    city: cleanStr(b.city, 120),
    state: cleanStr(b.state, 2).toUpperCase(),
  };

  const errors = {};
  if (value.name.length < 3) errors.name = 'Informe o nome completo';
  if (!isValidEmail(value.email)) errors.email = 'E-mail inválido';
  if (!isValidCPF(value.cpf)) errors.cpf = 'CPF inválido';
  if (!isValidPhone(value.phone)) errors.phone = 'Telefone com DDD inválido';
  if (!isValidCEP(value.cep)) errors.cep = 'CEP inválido';
  if (!value.street) errors.street = 'Informe a rua';
  if (!value.number) errors.number = 'Informe o número';
  if (!value.district) errors.district = 'Informe o bairro';
  if (!value.city) errors.city = 'Informe a cidade';
  if (!isValidUF(value.state)) errors.state = 'UF inválida';

  return { ok: Object.keys(errors).length === 0, value, errors };
}
