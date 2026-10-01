# Application guide

Target: https://www.saucedemo.com/  
Model: qwen2.5:14b  
Run started: 2026-10-01T15:35:17.794Z

> How this application behaves, as established by an autonomous exploratory
> agent. It records what was observed, not what was assumed - gaps are
> genuine gaps.

## Pages reached (3)

- https://www.saucedemo.com/
- https://www.saucedemo.com/inventory.html
- https://www.saucedemo.com/inventory-item.html?id=3

## What the run established

- The homepage of the application displays a login form with fields for username and password, and a login button.
- The password field is the next input field after the username field.
- The login button is labeled 'Login' and is the next step after entering the password.
- The login was successful and the user is redirected to the inventory page where products are listed.
- The inventory page offers a dropdown to sort products by name (A to Z), name (Z to A), price (low to high), and price (high to low).
- The sort dropdown is now open after clicking it.
- The product list has been sorted in descending alphabetical order by name after selecting 'Name (Z to A)' in the sort dropdown.
- The 'View details' button for the Test.allTheThings() T-Shirt (Red) product is clickable and should open the product details page.
- The product page for Test.allTheThings() T-Shirt (Red) displays details such as the product name, description, price, and an 'Add to cart' button. The page also includes social media links and a back button to return to the inventory page.

## Path taken

1. browser_snapshot({})
   - why: Take a snapshot to understand the initial state of the application.
   - learned: The homepage of the application displays a login form with fields for username and password, and a login button.
   - on the page: textbox "Username" | textbox "Password" | button "Login"
2. browser_snapshot({})
   - why: I need to take a snapshot to understand the login form and its elements better.
   - learned: The homepage contains a login form with fields for username and password, and a login button. It also provides accepted usernames and a password for all users.
   - on the page: textbox "Username" | textbox "Password" | button "Login"
3. browser_type({"target":"e11","text":"standard_user"})
   - why: I should attempt to log in with a standard user to explore the application further.
   - learned: The login form on the homepage accepts a username and password.
   - on the page: textbox "Username" | textbox "Password" | button "Login"
4. browser_type({"target":"e13","text":"secret_sauce"})
   - why: The username field has been filled. Next, I will fill the password field.
   - learned: The password field is the next input field after the username field.
   - on the page: textbox "Username" | textbox "Password" | button "Login"
5. browser_click({"target":"e15"})
   - why: I need to click the login button to proceed with logging in.
   - learned: The login button is labeled 'Login' and is the next step after entering the password.
6. browser_snapshot({})
   - why: The login was successful and I am now on the inventory page. I should take a snapshot to understand the layout and available products.
   - learned: The login was successful and the user is redirected to the inventory page where products are listed.
   - on the page: button "Open Menu" | button "Cart, empty" | generic | combobox "Sort products" | button "View details for Sauce Labs Backpack" | button "View details for Sauce Labs Backpack" | button "Add to cart" | button "View details for Sauce Labs Bike Light" | button "View details for Sauce Labs Bike Light" | button "Add to cart" | button "View details for Sauce Labs Bolt T-Shirt" | button "View details for Sauce Labs Bolt T-Shirt"
7. browser_find({"text":"Sort products"})
   - why: I need to understand the sorting functionality on the inventory page.
   - learned: The inventory page offers a dropdown to sort products by name (A to Z), name (Z to A), price (low to high), and price (high to low).
   - on the page: generic | combobox "Sort products"
8. browser_click({"target":"e38","button":"left"})
   - why: I need to explore the functionality of the dropdown to sort products by different options.
   - learned: The dropdown menu for sorting products is labeled 'Sort products' and contains options for sorting by name (A to Z), name (Z to A), and price (low to high).
   - on the page: generic | combobox "Sort products"
9. browser_snapshot({})
   - why: I clicked the sort dropdown and need to explore its options now.
   - learned: The sort dropdown is now open after clicking it.
   - on the page: button "Open Menu" | button "Cart, empty" | generic | combobox "Sort products" [active] | button "View details for Sauce Labs Backpack" | button "View details for Sauce Labs Backpack" | button "Add to cart" | button "View details for Sauce Labs Bike Light" | button "View details for Sauce Labs Bike Light" | button "Add to cart" | button "View details for Sauce Labs Bolt T-Shirt" | button "View details for Sauce Labs Bolt T-Shirt"
10. browser_select_option({"target":"e38","values":["Name (Z to A)"]})
   - why: I need to explore the sorting functionality by selecting different options in the dropdown.
   - learned: The sort dropdown offers options to sort products by name (A to Z), name (Z to A), price (low to high), and price (high to low).
   - on the page: button "Open Menu" | button "Cart, empty" | generic | combobox "Sort products" [active] | button "View details for Sauce Labs Backpack" | button "View details for Sauce Labs Backpack" | button "Add to cart" | button "View details for Sauce Labs Bike Light" | button "View details for Sauce Labs Bike Light" | button "Add to cart" | button "View details for Sauce Labs Bolt T-Shirt" | button "View details for Sauce Labs Bolt T-Shirt"
11. browser_snapshot({})
   - why: After selecting the 'Name (Z to A)' option, I need to take a snapshot to see the updated product list and verify the sorting.
   - learned: The product list has been sorted in descending alphabetical order by name after selecting 'Name (Z to A)' in the sort dropdown.
   - on the page: button "Open Menu" | button "Cart, empty" | generic | combobox "Sort products" | button "View details for Test.allTheThings() T-Shirt (Red)" | button "View details for Test.allTheThings() T-Shirt (Red)" | button "Add to cart" | button "View details for Sauce Labs Onesie" | button "View details for Sauce Labs Onesie" | button "Add to cart" | button "View details for Sauce Labs Fleece Jacket" | button "View details for Sauce Labs Fleece Jacket"
12. browser_click({"target":"e105"})
   - why: I need to take a closer look at the product details and add an item to the cart to see if the functionality works as expected.
   - learned: The 'View details' button for the Test.allTheThings() T-Shirt (Red) product is clickable and should open the product details page.
13. browser_snapshot({})
   - why: I need to take a snapshot to understand the details page for the Test.allTheThings() T-Shirt (Red) product.
   - learned: The 'View details' button for the Test.allTheThings() T-Shirt (Red) product navigates to a new page with detailed information about the product.
   - on the page: button "Open Menu" | button "Cart, empty" | button "Back to products" | button "Add to cart" | link "X" | link "Facebook" | link "LinkedIn"
14. browser_snapshot({})
   - why: I need to take a snapshot to understand the details of the product page and verify the functionality of the 'Add to cart' button.
   - learned: The product page for Test.allTheThings() T-Shirt (Red) displays details such as the product name, description, price, and an 'Add to cart' button. The page also includes social media links and a back button to return to the inventory page.
   - on the page: button "Open Menu" | button "Cart, empty" | button "Back to products" | button "Add to cart" | link "X" | link "Facebook" | link "LinkedIn"
