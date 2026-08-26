export const state = {
  items: [],
  currentStaff: null,   // {name, is_admin} после входа сотрудника
  currentStaffId: null, // auth.uid() вошедшего сотрудника (автор заявок «для себя»)
  clientsList: [],      // список клиентов (для админа — все, для бухгалтера — свои)
  staffList: [],        // список сотрудников (для выпадающего у админа)
  // Фильтр по карточкам-счётчикам. По умолчанию "due" — просроченные и на
  // сегодня, чтобы бухгалтер не оплатил случайно будущий платёж.
  quickFilter: "due",
  TOKEN: null,          // токен из ?t=<token> — режим клиента по токену
  clientInfo: null,     // {name} из client_by_token
  editingId: null,      // id редактируемой заявки (null = новая); теперь и у сотрудника
  formFiles: [],        // уже приложенные файлы в открытой форме — к ним добавятся новые
  _pollStarted: false,
};
