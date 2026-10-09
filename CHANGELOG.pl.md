# Spidx Uploader 2.8.0 — co nowego

**W skrócie:** wysyłanie klatki jednym skrótem klawiszowym, presety klientów, historia uploadów i nowa przeglądarka szablonów w panelu Premiere Pro. Do tego sporo poprawek, dzięki którym instalacja i aktualizacja paneli działa sprawniej.

---

## ✨ Nowości

### Wysyłanie klatki jednym skrótem
Naciśnij **Ctrl+Alt+U**, gdy na wierzchu jest After Effects, Premiere Pro, Photoshop albo VEGAS Pro, a bieżąca klatka zostanie wysłana — tak, jakbyś kliknął *Upload* w panelu Spidx.
**Ctrl+Alt+Shift+U** robi to samo trasą Camera Raw przez Photoshopa (*Photoshop + Upload*, Pro).
- Skrót zmienisz lub wyłączysz w **Dashboard → Settings → Global shortcut**.
- Za darmo dla wszystkich.
- Panel Spidx musi być otwarty w tym programie (*Window → Extensions*). Jeśli nie jest, pojawi się krótka informacja.

### Presety klientów
Zapisz bieżące ustawienia — cel uploadu, folder Google Drive, kompresję obrazu i akcję Camera Raw — jako preset z nazwą (np. *„Klient A"*) i przełączaj się między nimi jednym kliknięciem.
- Presetami zarządzasz w **Dashboard → Settings → Client presets**.
- Przełączasz je też bezpośrednio w panelach **After Effects** i **Premiere Pro** (nowa lista *Preset*).
- Pokazuje **„Active (modified)"**, gdy po zastosowaniu presetu zmienisz jakieś ustawienie.
- Za darmo dla wszystkich.

### Historia uploadów
Nowa zakładka **History** w Dashboardzie: ostatnie uploady (do 500) z linkami. Możesz ponownie skopiować link, szukać po nazwie pliku lub kliencie, usuwać wpisy albo wyczyścić listę. Dane zostają tylko na Twoim komputerze.

### Premiere Pro: szablony MOGRT (dodatek SPT)
Nowa zakładka **MOGRT** zamienia szablony motion graphics w przeglądarkę: miniatury, kategorie (Eliminations, Damage…), wyszukiwarka i animowane podglądy po najechaniu myszą.
- **Kliknij szablon**, a trafi na oś czasu w miejscu kursora, na wolną ścieżkę wideo nad V1. Nigdy nie rusza Twojego materiału.
- Wpisz nick (albo kliknij gracza w zakładce *Leaderboard*) i wpisze się sam do grafiki (Pro).
- Nic nie trzeba wcześniej instalować w Premiere.
- Część **Spidx Thumbnail Pack V3** (sprzedawany osobno; w rolach Dev i Tester wliczone). Panel Premiere Pro można zainstalować z licencją Pro **albo** z Packiem.

### Plugin VEGAS Pro jest częścią aplikacji
Zainstalujesz go w kreatorze albo w **Dashboard → Account → Plugins**. Sam buduje plugin pod Twoją wersję VEGAS-a. Wysyłanie z VEGAS Pro wymaga planu **Pro**.
Panel VEGAS ma nowy wygląd, zgodny z pozostałymi panelami, skaluje się z oknem i ma płynne animacje.

### Ustawienia kompresji obrazu
**Dashboard → Settings:** włącz lub wyłącz kompresję i wybierz docelowy rozmiar pliku. Presety mogą mieć inny rozmiar dla każdego klienta.

### Regulamin, EULA i Polityka prywatności
Linki do Regulaminu, umowy licencyjnej (EULA), Polityki prywatności i zasad zwrotów są w Dashboardzie (karta *Support & legal* i stopka na każdej zakładce). Nowe instalacje akceptują je raz w kreatorze, a obecni użytkownicy widzą krótki baner. Zapytamy ponownie dopiero, gdy teksty się zmienią.

### Self-test i diagnostyka
**Dashboard → Account → Diagnostics** sprawdza wszystko, czego potrzebuje uploader (Node, helper, foldery, logowanie Google, licencja, internet, pluginy) i prostymi słowami mówi, co jest nie tak. *Create diagnostics file* pakuje logi i wersje dla supportu — maile, tokeny i nazwa użytkownika są usuwane. Dostępne też z menu przy ikonie tray'a.

### Aktualizacje pluginów w aplikacji
Dashboard (i tray) informują, gdy jest nowszy plugin do After Effects, Premiere Pro, VEGAS-a lub Photoshopa, i mogą go pobrać. Potem klikasz *Update* przy pluginie.

### Łączone role licencji
Licencja może mieć kilka ról naraz (np. **Pro + SPT**), widocznych w Dashboardzie i panelach.

---

## 🔧 Ulepszenia
- **Instalator panelu Photoshop** uruchamia teraz instalator Adobe jako administrator i pokazuje prawdziwy wynik. Obniżono też minimalną wersję Photoshopa wymaganą przez panel.
- **Panel Premiere Pro** pamięta folder incoming, liczbę plików i inne ustawienia nawet po aktualizacji panelu, a po świeżej instalacji sam znajduje folder incoming.
- **Funkcje blokowane planem są zablokowane**, dopóki uploader nie pozna Twojego planu (2–3 pliki naraz, *Photoshop + Upload*, Properties).
- **Bezpieczniejsze sprawdzanie licencji.** Zmienione lub wygasłe lokalne dane licencji są ignorowane. Mocniejszą weryfikację podpisu można włączyć później bez aktualizacji aplikacji.
- **Dashboard:** stopka pokazuje wersję, a karta Support ma linki do Regulaminu i Polityki prywatności.

## 🐞 Poprawki
- Aplikacja w tray'u czasem nie chciała się uruchomić („already running") po restarcie lub awarii albo zostawiała niewidoczny proces.
- Po pojawieniu się informacji o aktualizacji w menu tray'a mogła uruchomić się zła pozycja menu.
- Gdy aplikacja w tray'u nie wystartowała bez okna, nic nie było widać — teraz pojawia się komunikat.
- Panel Photoshop: Dashboard potrafił napisać *„installed"*, gdy instalator Adobe się nie powiódł, albo *„not installed"* tuż po udanej instalacji. Panel After Effects (o tej samej nazwie) bywał brany za panel Photoshopa.
- Panel Premiere Pro: 2–3 pliki naraz i inne funkcje Pro dało się używać, zanim plan był znany.
- Szablony Premiere trafiały do folderu, którego Premiere nie czyta — teraz są wstawiane bezpośrednio.
- Panel VEGAS Pro: awaria przy zmianie regionu w Leaderboardzie, lista rozwijana, która zostawała otwarta, nakładający się tekst na wyłączonych przyciskach.
- Instalator Windows: mógł zakończyć niezwiązany program o ponownie użytym numerze procesu (teraz tylko własny proces uploadera), nie zawierał szablonów Premiere i nie kompilował się w nowszym Inno Setup.
- Komunikaty kompilatora pluginu VEGAS i programu skrótu były nieczytelne na polskim Windowsie.

---

## 📦 Wersje w tym wydaniu

| Część | Wersja |
|---|---|
| Spidx Uploader (aplikacja + instalator) | **2.8.0** |
| Panel After Effects | **2.8.0** |
| Panel Premiere Pro | **2.8.0** |
| Panel Photoshop | **2.8.0** |
| Plugin VEGAS Pro | **2.8.0** |

## ⬆️ Jak zaktualizować
1. Zamknij After Effects, Premiere Pro, Photoshopa i VEGAS Pro. Zamknij aplikację Spidx w tray'u.
2. Zainstaluj nową wersję (lub podmień pliki) i uruchom **Spidx Uploader**.
3. Wejdź w **Dashboard → Account → Plugins** i kliknij **Update** przy każdym pluginie (programy muszą być zamknięte). Przy Photoshopie pojawi się okno administratora Windows; po instalacji zrestartuj Photoshopa.
4. W Dashboardzie przeczytaj i zaakceptuj baner z Regulaminem / Polityką prywatności.

## ℹ️ Warto wiedzieć
- Pierwszy start buduje mały program skrótu (kilka sekund). Używa kompilatora, który jest w Windowsie.
- Skrót działa w programach z **nowym** panelem Spidx — zaktualizuj wszystkie pluginy.
- Przełączanie presetów z panelu działa w After Effects i Premiere Pro; w Photoshopie i VEGAS Pro użyj Dashboardu.
- Starsze wersje pluginu VEGAS nie podlegają wymogowi Pro — zaktualizuj plugin.
