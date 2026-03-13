# NLovitt.github.io

Private repository for hosting JavaScript snippets that can be injected into any web page via URL.

## Structure

```
index.html       — landing page listing available scripts
loader.html      — loads and runs a script specified by the ?src= URL parameter
js/              — injectable JavaScript snippets
  example.js     — example snippet (shows the current page title)
```

## Injecting a script

### Bookmarklet
Create a bookmark with the following URL (replace `example.js` with your script):

```
javascript:(function(){var s=document.createElement('script');s.src='https://nlovitt.github.io/js/example.js';document.body.appendChild(s);})();
```

### Browser console
```js
var s = document.createElement('script');
s.src = 'https://nlovitt.github.io/js/example.js';
document.body.appendChild(s);
```

### Loader page
Open `https://nlovitt.github.io/loader.html?src=js/example.js` to run any hosted script in an isolated page.

## Adding a new script

1. Add a `.js` file to the `js/` directory.
2. Add a row for it in the `index.html` table.

> **Note:** Replace `nlovitt.github.io` with your own GitHub Pages domain if you fork this repository.
