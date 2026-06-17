export const state = {
  items: [],
  currentStaff: null,   // {name, is_admin} после входа сотрудника
  clientsList: [],      // список клиентов (для админа — все, для бухгалтера — свои)
  staffList: [],        // список сотрудников (для выпадающего у админа)
  quickFilter: "",      // фильтр по карточкам-счётчикам
  TOKEN: null,          // токен из ?t=<token> — режим клиента по токену
  clientInfo: null,     // {name} из client_by_token
  _pollStarted: false,
};
