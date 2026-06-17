export const state = {
  items: [],
  currentStaff: null,   // {name, is_admin} после входа сотрудника
  clientsList: [],      // список клиентов (для админа — все, для бухгалтера — свои)
  staffList: [],        // список сотрудников (для выпадающего у админа)
  quickFilter: "",      // фильтр по карточкам-счётчикам
  CLIENT: null,         // строка из ?client=… — режим клиента (old)
  _pollStarted: false,
};
