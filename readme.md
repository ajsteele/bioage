# Simple tools for calculating biological age at home

I’m planning on making a few tools to calculate biological age at home using simple tests, but I’ve started with a complicated one, the PhenoAge clock, because I’m going to mention that in an upcoming video and I thought it would be nice if people could work out their own values. If you just want to try it out, head to [andrewsteele.co.uk/biological-age](https://andrewsteele.co.uk/biological-age/), or see [an example](https://andrewsteele.co.uk/biological-age/#age=34,years;albumin=4.5,g%2FdL;creatinine=99,%C2%B5mol%2FL;glucose=4.6,mmol%2FL;crp=0.22,mg%2FL;wbc=4.05,1000%20cells%2F%C2%B5L;lymphocyte=40,%25;mcv=85,fL;rcdw=12.9,%25;ap=36,U%2FL) with some values close to mine when I tried this (please note I’ve added noise to the test results to reduce the chances of my medical records being identified from them).

This repo will contain the basic HTML, JavaScript and CSS behind the calculators. If you find a problem, please report it as an issue, or I’d welcome pull requests building on this. Apologies in advance for my janky scientist-JavaScript—pull requests which make the code more beautiful are also welcome!

This code is free to use as you like but a link to [andrewsteele.co.uk/biological-age](https://andrewsteele.co.uk/biological-age/) would be very welcome, firstly to acknowledge the source, and secondly because I’m planning to build that page into a resource with more information about biological age calculations.

For privacy reasons, these calculators will never store your data. You can only access previous results by bookmarking the URL provided, and the results are stored in the URL anchor (the bit after the `#` symbol) which is never transmitted to the server—all the calculations are done locally in your web browser.

## Files

- `bioage.css` is a generic CSS file with a few small tweaks to visual appearance that will be used for all the calculators.
- `phenoage.html` and `phenoage.js` are the files used to calculate and display PhenoAge estimates from blood tests. Other measures of biological age will get their own HTML and JS files for tidyness.

## TODO

- There are a couple of `TODO`s in the JavaScript that would be nice to fix.
- Improve code commenting
- Add more units for the various tests.
- I should have coded the tests, results, units, etc as objects rather than arrays, to make keeping track of what’s going on easier.
- Add default values for people of a specific age, perhaps with a checkbox or other input so you can fill in if you’re missing a couple of tests. (Which I was when I did this!) Get these from the median values for each age of each test from the [NHANES data](https://wwwn.cdc.gov/nchs/nhanes/nhanes3/datafiles.aspx) this clock was trained on, make a CSV, allow the JavaScript to read that in.
- Add more methods of converting stuff to biological age, like time standing on one leg etc.
- It would be nice to include uncertainty ranges.