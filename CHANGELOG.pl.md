# Spidx Uploader 3.0.0 - co nowego

**W skrócie:** nowy silnik SE 3. Renderuj wideo prosto z Premiere Pro lub VEGAS Pro i wysyłaj je na Google Drive lub WorkUpload, a cały Dashboard mówi teraz w 9 językach.

## Nowości
- **Render i upload wideo** (Premiere Pro, VEGAS Pro): wybierasz własny preset/szablon renderu, program renderuje (bez dodatkowej kompresji), a helper wysyła gotowy plik. Klipy od 1 s do 30 min.
- **Wznawialny upload na Google Drive** dla dużych plików: postęp i prędkość na żywo w Dashboardzie, przycisk Anuluj, odporność na zrywanie sieci oraz kontynuacja po restarcie lub awarii.
- **Języki:** angielski, polski, niemiecki, francuski, hiszpański, portugalski (BR), włoski, turecki, rosyjski - Dashboard, kreator, tray. Zmiana w Dashboard → Language (Auto = język Windows).
- Pliki wideo są pobierane dopiero po pełnym zapisie, więc niedorenderowany plik nigdy nie poleci.
- **Przebudowany Dashboard:** boczne menu (Overview, History, Activity, Templates, Settings, Status, Account), status na żywo, ostatnie uploady, historia z miniaturami i filtrami, wyszukiwarka w ustawieniach z autozapisem, strona Status z kontrolami i raportem do skopiowania, jasny/ciemny motyw oraz baner o nowej wersji aplikacji lub paneli.
- **Szablony (Dashboard):** dodawanie plików .aep i przypisanie kompozycji oraz warstwy tekstowej do szablonu bez ręcznej edycji `templates.json`; zakładka SPT w After Effects odczytuje listę przy każdym otwarciu.
- **Leaderboard** idzie teraz przez helpera, więc panele After Effects / Premiere nie działają już z wyłączonymi zabezpieczeniami Chromium (`--disable-web-security` zniknęło). Żeby Leaderboard się wczytał, helper musi działać.
- **Render (After Effects / Premiere):** nazwy ze spacjami nie powodują już błędu „brak pliku”, podczas renderu widać zegar, a błędy mówią, co zgłosił AE lub Premiere.
- **Dowód licencji związany z komputerem:** po zainstalowaniu klucza RSA aplikacja wymaga też drugiego podpisu, ważnego tylko na komputerze, dla którego został wydany, więc plik licencji skopiowany na inny komputer nie działa. Dowód działa offline przez 14 dni.
- **Okno aktualizacji:** małe okno w stylu aplikacji (z pozycji „Update available” w zasobniku albo Dashboard > Account > Open the updater), które sprawdza wersję, pobiera instalator z postępem i przyciskiem Anuluj, uruchamia go oraz potrafi sprawdzić i naprawić zainstalowane panele.
- **Limit renderów liczony na serwerze:** 15 renderów w miesiącu w planie darmowym liczy teraz serwer licencji, osobno dla konta Google i dla komputera (podpisane odpowiedzi; 3 rendery w miesiącu przechodzą offline i są zgłaszane później). `render-usage.json` jest tylko pamięcią podręczną odpowiedzi serwera.
- **Paczki tylko dla miniaturek:** gdy „Files per upload” to 2 lub 3 albo paczka jest właśnie zbierana, „Render & upload” jest zablokowany w panelach After Effects, Premiere Pro i VEGAS Pro (z krótką informacją, dlaczego). Wyrenderowane wideo jest zawsze osobną wysyłką i nigdy nie trafia do paczki zdjęć.
- **WorkUpload znosi zamkniętą kartę:** jeśli karta WorkUpload albo okno przeglądarki zostanie zamknięte w trakcie wysyłki, helper zauważa to od razu (pętle oczekiwania sprawdzały martwą stronę przez minuty, a przy dużym wideo nawet godziny), otwiera nową kartę i zaczyna wysyłkę od nowa, bez zużywania próby (do 3 razy). Wysyłka, która mimo to się nie uda, jest zapamiętana i można ją ponowić przyciskiem „Retry now” w Overview Dashboardu; pliki nigdy nie są usuwane przez błąd. Karta, którą otworzysz sam, nie jest już przejmowana przez helpera.
- **Treść Thumbnail Pack dostarcza serwer, a nie instalator:** szablony i presety After Effects oraz szablony MOGRT do Premiere Pro nie są już w instalatorze ani w panelach. Serwer licencji wydaje je tylko kontu, które ma Pack (rola SPT albo dev / tester), i tylko na jednym z jego zarejestrowanych komputerów; helper pobiera je do `%APPDATA%\Spidx Uploader\pack`, sprawdza każdy plik podpisaną sumą kontrolną, dba o aktualność i usuwa je, gdy konto straci Pack. Dashboard > Templates pokazuje stan, ma przycisk Synchronizuj teraz i trzyma własne szablony użytkownika osobno. Konfiguracja dla właściciela: `Tools\PACK-README.txt`.
- **Panele w 9 językach:** panele After Effects, Premiere Pro i VEGAS Pro podążają teraz za językiem wybranym w Dashboardzie (helper przekazuje im słownik). Napisy bez tłumaczenia oraz te z nazwami lub liczbami zostają po angielsku.
- **Nowy wygląd kreatora i instalatora:** kreator pierwszego uruchomienia otwiera się we własnym oknie aplikacji w tym samym szklanym stylu co Dashboard i okno aktualizacji, a instalator Inno ma nowe grafiki.
- **Porządki:** usunięto martwe komunikaty „wymaga Pro” dla Premiere Pro i VEGAS Pro, nieużywane pole we wtyczce VEGAS oraz nieaktualne zdania w README.
- **Rozmiar panelu VEGAS Pro:** panel podąża teraz za skalowaniem ekranu (100% = normalny rozmiar, 125%, 150% itd. skalują się razem z Windowsem), a nie za stałym powiększeniem 1,3×, więc jest tak duży jak własny interfejs VEGAS na każdym komputerze, a cały panel jest o około jedną czwartą niższy. Ręcznie ustawisz to kluczem `panelScale` w `%APPDATA%\Spidx Uploader\vegas-panel-config.json`; stary, zapisywany automatycznie `uiScale` jest ignorowany.
- **Panel VEGAS Pro w wąskim oknie:** nagłówek nie ucina już nazwy (plakietka planu skraca się do „TESTER”, a w bardzo wąskim oknie nazwa lekko się zmniejsza i znika małe „S”), a przycisk „Photoshop + Upload” zawija się na dwie linie („PS + Upload”, gdy i to się nie mieści) zamiast być ucięty.
- **Nowe plany:** wersja darmowa zawiera teraz panel Premiere Pro i wtyczkę VEGAS Pro oraz 15 renderów wideo w miesiącu kalendarzowym (Render & upload, liczone łącznie dla wszystkich aplikacji; zdjęcia nie są liczone). Pro ma nieograniczone rendery i uploady. Dashboard pokazuje licznik i ostrzega przed limitem, a panele ostrzegają przed renderem, który zostałby odrzucony. Wideo ponad limit trafia do `incoming\rejected` i nigdy nie jest usuwane.
- **Nowe logo:** gradientowe „S” jest teraz logo wszędzie: w Dashboardzie, kreatorze, zasobniku, skrócie na pulpicie i w ikonach paneli After Effects i Premiere Pro (panel Photoshop zachowa starą ikonę do czasu przebudowy).
- Panele mają ten sam szklany wygląd co Dashboard. HTML/CSS/JS Dashboardu przeniesiono z `dashboard.js` do `App\dashboard-ui\`.

## Uwagi
- Render w VEGAS jest nowy i wymaga ponownego zbudowania wtyczki (`build.bat`).
- Panele (Premiere, After Effects, VEGAS, Photoshop) na razie tylko po angielsku.

---

