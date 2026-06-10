const customerTokenKey = "behavior-storefront-customer-token";

export function getCustomerToken() {
  return window.localStorage.getItem(customerTokenKey) || "";
}

export function setCustomerToken(token: string) {
  window.localStorage.setItem(customerTokenKey, token);
}

export function clearCustomerToken() {
  window.localStorage.removeItem(customerTokenKey);
}
