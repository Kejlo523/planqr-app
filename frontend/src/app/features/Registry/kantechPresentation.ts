export const outcomeLabel: Record<string, string> = {
  observed: "Odczytano",
  opened: "Otwarto listę",
  closed: "Zamknięto listę",
  recorded: "Dopisano obecność",
  pending: "Oczekuje na plan",
  choose_lesson: "Oczekuje na wybór zajęć",
  no_match: "Brak pasujących zajęć",
  no_session: "Brak otwartej listy",
  unknown_card: "Karta nieprzypisana",
  unknown_reader: "Czytnik nieprzypisany",
  reader_without_room: "Czytnik bez przypisanej sali",
  reader_without_pair: "Czytnik bez pary wejście–wyjście",
  close_too_soon: "Na zamknięcie listy trzeba odczekać minutę",
  exit_ignored: "Odbicie na wyjściu bez zamknięcia listy",
  wrong_entry_reader: "Wejście poza aktywną listą",
  room_in_use: "Sala ma już aktywną listę",
  invalid_time: "Niejednoznaczny czas odbicia",
  outside_cutover: "Poza zakresem zapisu",
  access_denied: "Odmowa dostępu",
  repeat_tap: "Powtórzone przyłożenie",
  already_closed: "Lista już zamknięta",
};

export const kantechTime = new Intl.DateTimeFormat("pl-PL", {
  day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  second: "2-digit", timeZone: "Europe/Warsaw",
});
